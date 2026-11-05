/**
 * The account service API (docs/account.md, "Account service API") in memory, for tests of the PC
 * and the apps. Not a service: no sign-in, no push, no persistence. `issueToken` stands in for a
 * finished sign-in. It checks what the real service must check (record shape and signature, the
 * caller's directory, server proof with the `account` role), so tests fail where a PC or app relies
 * on something the service would refuse.
 */
import { ACCOUNT_RECORDS_MAX, AccountRecordError, readAccountRecord, type AccountRecord } from "./account-records.ts";
import { deriveServerId, proofKey, serverChallenge, verifyServerProof } from "./relay-server-proof.ts";

export const CHALLENGE_TTL_MS = 60_000;
export const MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAILBOX_PAGE = 100;

export interface FakePc { server_id: string; label: string; added_at: string; last_seen_at: string | null }
export interface FakeAdmission { id: string; server_id: string; label: string; at: string }

interface Mail { seq: number; record: AccountRecord; at: number }

export class FakeAccountService {
  private readonly tokens = new Map<string, string>();
  private readonly directories = new Map<string, Map<string, FakePc>>();
  private readonly mailboxes = new Map<string, Mail[]>();
  private readonly challenges = new Map<string, { server_id: string; expected: string; expires: number }>();
  private readonly admissionList: FakeAdmission[] = [];
  private seq = 0;
  /** Every request the fake answered, oldest first: `METHOD /path`. */
  readonly requests: string[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** A bearer token for `account`, as if its owner had just signed in. */
  issueToken(account: string): string {
    const token = randomHex(32);
    this.tokens.set(token, account);
    return token;
  }

  revokeToken(token: string): void { this.tokens.delete(token); }

  pcs(account: string): FakePc[] { return [...this.directories.get(account)?.values() ?? []]; }

  admissions(): readonly FakeAdmission[] { return this.admissionList; }

  /** What a PC would still get from its mailbox, for assertions; the service hiding a record is `drop`. */
  mailbox(serverId: string): AccountRecord[] {
    this.expire();
    return (this.mailboxes.get(serverId) ?? []).map(({ record }) => record);
  }

  /** A misbehaving service: removes queued records it should have delivered. */
  drop(serverId: string, predicate: (record: AccountRecord) => boolean): void {
    this.mailboxes.set(serverId, (this.mailboxes.get(serverId) ?? []).filter(({ record }) => !predicate(record)));
  }

  /** Answers like the service: pass it as the PC's or app's `fetch`. */
  readonly fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);
    try {
      if (url.pathname.startsWith("/v1/pc/")) return await this.pc(request, url.pathname);
      return await this.client(request, url.pathname);
    } catch (error) {
      if (error instanceof AccountRecordError) return problem(400, "record_invalid", error.message);
      if (error instanceof SyntaxError) return problem(400, "invalid_json", "The body is not JSON");
      throw error;
    }
  };

  private async client(request: Request, path: string): Promise<Response> {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const account = bearer === undefined ? undefined : this.tokens.get(bearer);
    if (account === undefined) return problem(401, "unauthorized", "Sign in again");
    const directory = this.directories.get(account) ?? new Map<string, FakePc>();
    this.directories.set(account, directory);
    if (path === "/v1/pcs" && request.method === "GET") return json({ pcs: [...directory.values()] });
    const pc = /^\/v1\/pcs\/([0-9a-f]{32})$/.exec(path)?.[1];
    if (pc !== undefined && request.method === "PUT") {
      const body = await request.json() as { label?: unknown };
      if (typeof body.label !== "string" || body.label.length < 1 || body.label.length > 48) return problem(400, "invalid_label", "Name the PC");
      const entry = { server_id: pc, label: body.label, added_at: directory.get(pc)?.added_at ?? this.iso(), last_seen_at: directory.get(pc)?.last_seen_at ?? null };
      directory.set(pc, entry);
      return json({ pc: entry });
    }
    if (pc !== undefined && request.method === "DELETE") {
      directory.delete(pc);
      return new Response(null, { status: 204 });
    }
    if (path === "/v1/records" && request.method === "POST") {
      const body = await request.json() as { server_ids?: unknown; record?: unknown };
      if (!Array.isArray(body.server_ids) || body.server_ids.length > ACCOUNT_RECORDS_MAX || !body.server_ids.every((id) => typeof id === "string" && directory.has(id))) {
        return problem(400, "unknown_pc", "List PCs of this account only");
      }
      const record = await readAccountRecord(body.record);
      if (!record) return problem(400, "signature_invalid", "The signature does not hold");
      if (record.account !== account) return problem(403, "account_mismatch", "The record is for another account");
      for (const id of new Set(body.server_ids as string[])) {
        const box = this.mailboxes.get(id) ?? [];
        box.push({ seq: ++this.seq, record, at: this.now() });
        this.mailboxes.set(id, box);
      }
      return json({ queued: new Set(body.server_ids).size });
    }
    if (path === "/v1/admissions" && request.method === "POST") {
      const body = await request.json() as { server_id?: unknown; label?: unknown };
      if (typeof body.server_id !== "string" || !directory.has(body.server_id) || typeof body.label !== "string") return problem(400, "unknown_pc", "List PCs of this account only");
      const admission = { id: randomHex(16), server_id: body.server_id, label: body.label, at: this.iso() };
      this.admissionList.push(admission);
      return json({ id: admission.id });
    }
    return problem(404, "not_found", "Unknown request");
  }

  private async pc(request: Request, path: string): Promise<Response> {
    if (request.method !== "POST") return problem(404, "not_found", "Unknown request");
    const body = await request.json() as Record<string, unknown>;
    if (path === "/v1/pc/challenge") {
      const key = proofKey(body.public_key);
      if (!key || typeof body.server_id !== "string" || deriveServerId(key) !== body.server_id) return problem(401, "server_key_mismatch", "That key does not give that server_id");
      const challengeId = randomHex(16);
      const { expected, frame } = serverChallenge(key, { server_id: body.server_id, role: "account", connection_id: challengeId });
      this.challenges.set(challengeId, { server_id: body.server_id, expected, expires: this.now() + CHALLENGE_TTL_MS });
      return json({ challenge_id: challengeId, frame });
    }
    if (path === "/v1/pc/mailbox") {
      const challenge = typeof body.challenge_id === "string" ? this.challenges.get(body.challenge_id) : undefined;
      if (typeof body.challenge_id === "string") this.challenges.delete(body.challenge_id);
      if (!challenge || challenge.server_id !== body.server_id || this.now() > challenge.expires || !verifyServerProof(body.proof, challenge.expected)) {
        return problem(401, "proof_invalid", "Ask for a new challenge and answer it");
      }
      this.expire();
      const box = this.mailboxes.get(challenge.server_id) ?? [];
      const ack = typeof body.ack === "number" ? body.ack : null;
      const rest = ack === null ? box : box.filter(({ seq }) => seq > ack);
      this.mailboxes.set(challenge.server_id, rest);
      for (const directory of this.directories.values()) {
        const entry = directory.get(challenge.server_id);
        if (entry) entry.last_seen_at = this.iso();
      }
      return json({ records: rest.slice(0, MAILBOX_PAGE).map(({ seq, record }) => ({ seq, record })), more: rest.length > MAILBOX_PAGE });
    }
    return problem(404, "not_found", "Unknown request");
  }

  private expire(): void {
    const cutoff = this.now() - MAILBOX_TTL_MS;
    for (const [id, box] of this.mailboxes) this.mailboxes.set(id, box.filter(({ at }) => at > cutoff));
  }

  private iso(): string { return new Date(this.now()).toISOString(); }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function problem(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
