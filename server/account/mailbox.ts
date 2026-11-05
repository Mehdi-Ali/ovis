/**
 * The PC's mailbox at the account service (docs/account.md, "Account service API"): records left for
 * this PC while it was off. The PC signs in with nothing but its relay key, answering a server proof
 * for the `account` role, which the relay itself never accepts. The service can hold records back,
 * never forge one: each is checked and applied like a record a client hands over directly.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { ACCOUNT_RECORDS_MAX, isAccountKey } from "../../shared/account-records.ts";
import { importPublicKey, importSecretKey } from "../../shared/relay-e2ee.ts";
import { answerServerChallenge } from "../../shared/relay-server-proof.ts";
import type { DeviceStore } from "../devices.ts";
import type { RelayIdentity } from "../relay/identity.ts";
import { applyAccountRecords } from "./records.ts";

export const MAILBOX_PULL_MS = 5 * 60_000;
/** How old an admission may be for the PC to take an account join outside the pairing window. */
export const ADMISSION_TTL_MS = 10 * 60_000;
/** Pages one pull reads at most; the rest waits for the next pull. */
const MAX_PAGES = 20;

export function accountServiceUrl(value = process.env["OVIS_ACCOUNT_SERVICE_URL"] ?? "https://account.ovis.sh"): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("The account service must be https");
  return url.origin;
}

export interface AccountMailboxOptions {
  readonly devices: DeviceStore;
  /** This PC's relay identity, when it has one; its `server_id` names the mailbox. */
  readonly identity: () => RelayIdentity | undefined;
  /** The account service's origin, or why none can be used (a bad OVIS_ACCOUNT_SERVICE_URL), shown as the mailbox's error. */
  readonly service: string | Error;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export class AccountMailbox {
  lastPullAt: string | null = null;
  /** The account's admissions for this PC the last pull saw, by the waiting device's key: when each was made. */
  private admissions = new Map<string, number>();
  error: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private pulling: Promise<number> | undefined;

  constructor(private readonly options: AccountMailboxOptions) {}

  /** Pulls now unless a pull is under way; how many records changed something. Never throws. */
  pull(): Promise<number> {
    this.pulling ??= this.drain().finally(() => { this.pulling = undefined; });
    return this.pulling;
  }

  start(): void {
    if (this.timer) return;
    void this.pull();
    this.timer = setInterval(() => { void this.pull(); }, MAILBOX_PULL_MS);
    this.timer.unref?.();
  }

  /** Whether the account service has a fresh admission (at most 10 minutes old) naming `key`; pulls once if not yet seen. */
  async admitted(key: string, now = Date.now()): Promise<boolean> {
    const fresh = () => { const at = this.admissions.get(key); return at !== undefined && now - at < ADMISSION_TTL_MS && at <= now + 60_000; };
    if (fresh()) return true;
    await this.pull();
    return fresh();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async drain(): Promise<number> {
    const account = this.options.devices.account();
    const identity = this.options.identity();
    if (account === null || !identity) return 0;
    if (this.options.service instanceof Error) { this.error = this.options.service.message; return 0; }
    // a removal refused for a local reason would be acknowledged and lost: collect nothing until it is fixed
    if (this.options.devices.accountError !== null) { this.error = this.options.devices.accountError; return 0; }
    let applied = 0;
    let ack: number | null = null;
    try {
      const admissions = new Map<string, number>();
      for (let page = 0; ; page++) {
        // past the last page read, one more call only acknowledges it; what it returns waits for the next pull
        const { entries, waiting } = await this.page(identity, account, ack);
        for (const admission of waiting) admissions.set(admission.key, Date.parse(admission.at));
        if (entries.length === 0 || page === MAX_PAGES) break;
        for (let start = 0; start < entries.length; start += ACCOUNT_RECORDS_MAX) {
          const outcomes = await applyAccountRecords(this.options.devices, entries.slice(start, start + ACCOUNT_RECORDS_MAX).map(({ record }) => record), identity.server_id);
          applied += outcomes.filter(({ outcome }) => outcome === "applied").length;
        }
        // every record read is acknowledged, refused ones too, so a refused one cannot hold the rest back
        ack = Math.max(...entries.map(({ seq }) => seq));
      }
      this.admissions = admissions;
      this.lastPullAt = new Date().toISOString();
      this.error = null;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    return applied;
  }

  private async page(identity: RelayIdentity, account: string, ack: number | null): Promise<{ entries: { seq: number; record: unknown }[]; waiting: { key: string; at: string }[] }> {
    const call = async (path: string, body: unknown) => {
      const response = await (this.options.fetch ?? fetch)(new Request(String(this.options.service) + path, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      }));
      if (!response.ok) throw new Error(`The account service answered ${response.status} to ${path}`);
      return await response.json() as Record<string, unknown>;
    };
    const publicKey = bytesToHex(importPublicKey(identity.public_key));
    const challenge = await call("/v1/pc/challenge", { server_id: identity.server_id, public_key: publicKey });
    if (typeof challenge.challenge_id !== "string") throw new Error("The account service sent no challenge");
    const proof = answerServerChallenge(challenge.frame, importSecretKey(identity.secret_key),
      { server_id: identity.server_id, role: "account", connection_id: challenge.challenge_id });
    if (!proof) throw new Error("The account service sent a malformed challenge");
    const mailbox = await call("/v1/pc/mailbox", { server_id: identity.server_id, challenge_id: challenge.challenge_id, proof, account, ack });
    const records = mailbox.records;
    if (!Array.isArray(records) || !records.every((entry) => typeof entry === "object" && entry !== null && Number.isSafeInteger((entry as { seq?: unknown }).seq))) {
      throw new Error("The account service sent a malformed mailbox");
    }
    const admissions = Array.isArray(mailbox.admissions) ? mailbox.admissions : [];
    const waiting = admissions.filter((a): a is { key: string; at: string } => typeof a === "object" && a !== null
      && isAccountKey((a as { key?: unknown }).key) && typeof (a as { at?: unknown }).at === "string" && !Number.isNaN(Date.parse((a as { at: string }).at)));
    return { entries: records as { seq: number; record: unknown }[], waiting };
  }
}
