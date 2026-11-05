/**
 * The account service API (docs/account.md, "Account service API") in memory, for tests of the PC
 * and the apps. Not a service: no provider behind sign-in, no push, no persistence. `signInAs` says who
 * the next sign-in is, `appleIdToken` stands in for Apple's, and `issueToken` skips sign-in altogether. It checks what the real service must check (record shape and signature, the
 * caller's directory, server proof with the `account` role), so tests fail where a PC or app relies
 * on something the service would refuse.
 */
import { ACCOUNT_RECORDS_MAX, AccountRecordError, readAccountRecord, type AccountRecord } from "./account-records.ts";
import { deriveServerId, proofKey, serverChallenge, verifyServerProof } from "./relay-server-proof.ts";

export const CHALLENGE_TTL_MS = 60_000;
export const MAILBOX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAILBOX_PAGE = 100;
/** Records one account may hold for one PC at once; past it, `/v1/records` answers 429 `mailbox_full`. */
export const MAILBOX_MAX = 1000;
export const ACCESS_TOKEN_TTL_S = 3600;
export const SIGNIN_CODE_TTL_MS = 60_000;

export type SignInProvider = "github" | "apple";

/** The web app's redirect: the code comes back in the fragment there, so it never reaches the host's logs. */
export const WEB_REDIRECT = "https://app.ovis.sh/";

/** The only redirects sign-in returns to (docs/account.md, "Signing in"), compared exactly. */
export function isAllowedRedirect(uri: string): boolean {
  if (uri === WEB_REDIRECT || uri === "ovis://account/callback") return true;
  const loopback = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})\/callback$/.exec(uri);
  return loopback !== null && Number(loopback[1]) >= 1 && Number(loopback[1]) <= 65535;
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;

interface Session { account: string; provider: SignInProvider | "test"; family: string; expires: number }

export interface FakePc { server_id: string; label: string; added_at: string; last_seen_at: string | null }
export interface FakeAdmission { id: string; server_id: string; label: string; at: string }

interface Mail { seq: number; record: AccountRecord; at: number }

export class FakeAccountService {
  private readonly tokens = new Map<string, Session>();
  private readonly codes = new Map<string, { account: string; provider: SignInProvider; challenge: string; redirect: string; expires: number }>();
  private readonly refreshTokens = new Map<string, { account: string; provider: SignInProvider; family: string; used: boolean }>();
  private readonly revokedFamilies = new Set<string>();
  private readonly appleTokens = new Map<string, { account: string; nonce: string }>();
  private readonly signIns = new Map<SignInProvider, string>();
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
    this.tokens.set(token, { account, provider: "test", family: randomHex(16), expires: Number.POSITIVE_INFINITY });
    return token;
  }

  /** Who the next sign-in with `provider` turns out to be; unset, `acct_<provider>`. */
  signInAs(provider: SignInProvider, account: string): void { this.signIns.set(provider, account); }

  /** An identity token as Sign in with Apple hands an iOS app, for `account` and the app's `nonce`. */
  appleIdToken(account: string, nonce: string): string {
    const token = randomHex(32);
    this.appleTokens.set(token, { account, nonce });
    return token;
  }

  revokeToken(token: string): void { this.tokens.delete(token); }

  private grant(account: string, provider: SignInProvider, family = randomHex(16)) {
    const access = randomHex(32);
    const refresh = randomHex(32);
    this.tokens.set(access, { account, provider, family, expires: this.now() + ACCESS_TOKEN_TTL_S * 1000 });
    this.refreshTokens.set(refresh, { account, provider, family, used: false });
    return json({ access_token: access, refresh_token: refresh, expires_in: ACCESS_TOKEN_TTL_S, account, provider });
  }

  private signIn(url: URL, provider: string): Response {
    if (provider !== "github" && provider !== "apple") return problem(404, "not_found", "Unknown provider");
    const redirect = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("code_challenge") ?? "";
    if (!isAllowedRedirect(redirect)) return problem(400, "invalid_redirect_uri", "That redirect is not allowed");
    // the web redirect always takes the fragment; the app's scheme may ask for it; a loopback server never sees one
    const mode = url.searchParams.get("response_mode") ?? (redirect === WEB_REDIRECT ? "fragment" : "query");
    const loopback = redirect.startsWith("http://127.0.0.1:");
    if ((mode !== "fragment" && mode !== "query") || (redirect === WEB_REDIRECT && mode !== "fragment") || (loopback && mode !== "query")) {
      return problem(400, "invalid_request", "That response_mode does not go with that redirect");
    }
    if (url.searchParams.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge) || state.length === 0) {
      return problem(400, "invalid_request", "Send state and an S256 code_challenge");
    }
    const code = randomHex(32);
    this.codes.set(code, { account: this.signIns.get(provider) ?? `acct_${provider}`, provider, challenge, redirect, expires: this.now() + SIGNIN_CODE_TTL_MS });
    const back = new URL(redirect);
    const answer = new URLSearchParams({ code, state });
    if (mode === "fragment") back.hash = answer.toString();
    else back.search = answer.toString();
    return new Response(null, { status: 302, headers: { location: back.href } });
  }

  private async token(request: Request): Promise<Response> {
    const body = await request.json() as Record<string, unknown>;
    const invalid = (message: string) => problem(400, "invalid_grant", message);
    switch (body.grant_type) {
      case "authorization_code": {
        const code = typeof body.code === "string" ? this.codes.get(body.code) : undefined;
        if (typeof body.code === "string") this.codes.delete(body.code);
        if (!code || this.now() > code.expires || body.redirect_uri !== code.redirect) return invalid("The code is wrong, spent or expired");
        if (typeof body.code_verifier !== "string" || !PKCE.test(body.code_verifier) || await s256(body.code_verifier) !== code.challenge) return invalid("The code_verifier does not match");
        return this.grant(code.account, code.provider);
      }
      case "refresh_token": {
        const refresh = typeof body.refresh_token === "string" ? this.refreshTokens.get(body.refresh_token) : undefined;
        if (!refresh || this.revokedFamilies.has(refresh.family)) return invalid("Sign in again");
        // a refresh token is good once: seeing it again means it leaked, so the whole family goes
        if (refresh.used) { this.revokeFamily(refresh.family); return invalid("Sign in again"); }
        refresh.used = true;
        return this.grant(refresh.account, refresh.provider, refresh.family);
      }
      case "apple_id_token": {
        const apple = typeof body.id_token === "string" ? this.appleTokens.get(body.id_token) : undefined;
        if (typeof body.id_token === "string") this.appleTokens.delete(body.id_token);
        if (!apple || typeof body.nonce !== "string" || body.nonce !== apple.nonce) return invalid("The identity token is not valid for that nonce");
        return this.grant(apple.account, "apple");
      }
      default: return problem(400, "unsupported_grant_type", "Use authorization_code, refresh_token or apple_id_token");
    }
  }

  private revokeFamily(family: string): void {
    this.revokedFamilies.add(family);
    for (const [token, session] of this.tokens) if (session.family === family) this.tokens.delete(token);
  }

  pcs(account: string): FakePc[] { return [...this.directories.get(account)?.values() ?? []]; }

  admissions(): readonly FakeAdmission[] { return this.admissionList; }

  /** What a PC would still get from `account`'s mailbox for it, for assertions; the service hiding a record is `drop`. */
  mailbox(serverId: string, account: string): AccountRecord[] {
    this.expire();
    return (this.mailboxes.get(box(serverId, account)) ?? []).map(({ record }) => record);
  }

  /** A misbehaving service: removes queued records it should have delivered. */
  drop(serverId: string, account: string, predicate: (record: AccountRecord) => boolean): void {
    const key = box(serverId, account);
    this.mailboxes.set(key, (this.mailboxes.get(key) ?? []).filter(({ record }) => !predicate(record)));
  }

  /** Answers like the service: pass it as the PC's or app's `fetch`. */
  readonly fetch = async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    this.requests.push(`${request.method} ${url.pathname}`);
    try {
      if (url.pathname.startsWith("/v1/pc/")) return await this.pc(request, url.pathname);
      const provider = /^\/v1\/signin\/([a-z]+)$/.exec(url.pathname)?.[1];
      if (provider !== undefined && request.method === "GET") return this.signIn(url, provider);
      if (url.pathname === "/v1/token" && request.method === "POST") return await this.token(request);
      return await this.client(request, url.pathname);
    } catch (error) {
      if (error instanceof AccountRecordError) return problem(400, "record_invalid", error.message);
      if (error instanceof SyntaxError) return problem(400, "invalid_json", "The body is not JSON");
      throw error;
    }
  };

  private async client(request: Request, path: string): Promise<Response> {
    const bearer = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const session = bearer === undefined ? undefined : this.tokens.get(bearer);
    if (session === undefined || this.now() >= session.expires || this.revokedFamilies.has(session.family)) return problem(401, "unauthorized", "Sign in again");
    const account = session.account;
    if (path === "/v1/signout" && request.method === "POST") {
      this.revokeFamily(session.family);
      return new Response(null, { status: 204 });
    }
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
      const targets = [...new Set(body.server_ids as string[])];
      this.expire();
      if (targets.some((id) => (this.mailboxes.get(box(id, account))?.length ?? 0) >= MAILBOX_MAX)) return problem(429, "mailbox_full", "That PC has not collected its records");
      for (const id of targets) {
        const queue = this.mailboxes.get(box(id, account)) ?? [];
        queue.push({ seq: ++this.seq, record, at: this.now() });
        this.mailboxes.set(box(id, account), queue);
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
      if (typeof body.account !== "string") return problem(400, "invalid_account", "Name the account this PC belongs to");
      this.expire();
      const key = box(challenge.server_id, body.account);
      const queue = this.mailboxes.get(key) ?? [];
      const ack = typeof body.ack === "number" ? body.ack : null;
      const rest = ack === null ? queue : queue.filter(({ seq }) => seq > ack);
      this.mailboxes.set(key, rest);
      // only the account the PC says it belongs to learns that it came by
      const entry = this.directories.get(body.account)?.get(challenge.server_id);
      if (entry) entry.last_seen_at = this.iso();
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

/** One mailbox per PC and account: another account's records can neither fill nor hide this account's. */
function box(serverId: string, account: string): string {
  return `${serverId}\0${account}`;
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
