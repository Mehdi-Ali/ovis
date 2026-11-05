/**
 * The account service as this client calls it (docs/account.md, "Account service API"): the
 * directory of the account's PCs, and the tokens a sign-in gives. Answers are parsed here, at the
 * edge; a token is never logged or put in an error's text.
 */
import type { AccountProvider, AccountSession, AccountStore } from "./store.ts";
import { ACCOUNT_PROVIDERS } from "./store.ts";

/**
 * The account service this page signs in with, from `<meta name="ovis-account-service">`: an https
 * origin, or http on loopback for a local test. None, or one that is neither, and the page offers
 * no sign-in at all, so a build is never left with buttons for a service it cannot reach.
 */
export function accountServiceOf(document: { querySelector(selector: string): { getAttribute(name: string): string | null } | null }): string | null {
  const content = document.querySelector('meta[name="ovis-account-service"]')?.getAttribute("content");
  if (!content) return null;
  let url: URL;
  try { url = new URL(content); } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  return url.protocol === "https:" || (url.protocol === "http:" && loopback) ? url.origin : null;
}

/** A refresh this long before the access token runs out, so a request never leaves with one about to. */
const REFRESH_EARLY_MS = 60_000;

export class AccountServiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AccountServiceError";
  }
}

/** The sign-in is gone (revoked, expired past refresh, or never made): the client is signed out. */
export class SignedOutError extends Error {
  readonly code = "signed_out";
  constructor() {
    super("Sign in to your account again");
    this.name = "SignedOutError";
  }
}

export interface DirectoryPc {
  readonly server_id: string;
  readonly label: string;
  readonly added_at: string;
  readonly last_seen_at: string | null;
}

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

const SERVER_ID = /^[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function failure(response: Response): Promise<AccountServiceError> {
  let code = "http_error";
  let message = `The account service answered ${response.status}`;
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : null;
    if (typeof error?.code === "string") code = error.code;
    if (typeof error?.message === "string") message = error.message;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return new AccountServiceError(response.status, code, message);
}

function parsePc(value: unknown): DirectoryPc | null {
  if (!isRecord(value) || typeof value.server_id !== "string" || !SERVER_ID.test(value.server_id)) return null;
  if (typeof value.label !== "string" || typeof value.added_at !== "string") return null;
  if (value.last_seen_at !== null && typeof value.last_seen_at !== "string") return null;
  return { server_id: value.server_id, label: value.label, added_at: value.added_at, last_seen_at: value.last_seen_at };
}

export function sessionOf(body: unknown, service: string, now: number): AccountSession {
  if (!isRecord(body)) throw new AccountServiceError(502, "invalid_answer", "The account service sent no sign-in");
  const { access_token, refresh_token, expires_in, account, provider } = body;
  if (typeof access_token !== "string" || access_token === "" || typeof refresh_token !== "string" || refresh_token === ""
    || typeof expires_in !== "number" || !(expires_in > 0) || typeof account !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(account)
    || !ACCOUNT_PROVIDERS.includes(provider as AccountProvider)) {
    throw new AccountServiceError(502, "invalid_answer", "The account service sent an incomplete sign-in");
  }
  return { service, account, provider: provider as AccountProvider, access_token, refresh_token, expires_at: now + expires_in * 1000 };
}

/** `POST /v1/token`: a code, a refresh token or a native Apple token for a session. */
export async function requestToken(service: string, grant: Record<string, string>, options: { fetch?: Fetch; now?: () => number } = {}): Promise<AccountSession> {
  const now = options.now ?? Date.now;
  const response = await (options.fetch ?? fetch)(new URL("/v1/token", service), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(grant),
  });
  if (!response.ok) throw await failure(response);
  return sessionOf(await response.json(), service, now());
}

export interface AccountServiceOptions {
  readonly store: AccountStore;
  readonly fetch?: Fetch;
  readonly now?: () => number;
}

/**
 * Calls on the signed-in account. An access token about to run out is refreshed first; a refused
 * refresh, or a 401 after one, signs this client out (the stored session goes) and throws
 * SignedOutError. PC pairings are untouched: they never depended on the sign-in.
 */
export class AccountService {
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private refreshing: Promise<AccountSession> | null = null;

  constructor(private readonly options: AccountServiceOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async session(): Promise<AccountSession | undefined> {
    return this.options.store.get("session");
  }

  async listPcs(): Promise<DirectoryPc[]> {
    const body = await this.call("GET", "/v1/pcs");
    const pcs = isRecord(body) && Array.isArray(body.pcs) ? body.pcs : null;
    if (pcs === null) throw new AccountServiceError(502, "invalid_answer", "The account service sent no PC list");
    return pcs.map(parsePc).filter((pc): pc is DirectoryPc => pc !== null);
  }

  async putPc(serverId: string, label: string): Promise<void> {
    await this.call("PUT", `/v1/pcs/${serverId}`, { label });
  }

  /** Ends the sign-in on the service and here; a service that cannot be reached still forgets it here. */
  async signOut(): Promise<void> {
    const session = await this.session();
    if (session === undefined) return;
    await this.options.store.set("session", undefined);
    const response = await this.fetch(new URL("/v1/signout", session.service), { method: "POST", headers: { authorization: `Bearer ${session.access_token}` } });
    if (!response.ok && response.status !== 401) throw await failure(response);
  }

  private async signedOut(): Promise<never> {
    await this.options.store.set("session", undefined);
    throw new SignedOutError();
  }

  private async fresh(force: boolean): Promise<AccountSession> {
    const session = await this.session();
    if (session === undefined) return this.signedOut();
    if (!force && session.expires_at - REFRESH_EARLY_MS > this.now()) return session;
    this.refreshing ??= requestToken(session.service, { grant_type: "refresh_token", refresh_token: session.refresh_token }, { fetch: this.fetch, now: this.now })
      .then(async (next) => { await this.options.store.set("session", next); return next; })
      .finally(() => { this.refreshing = null; });
    try {
      return await this.refreshing;
    } catch (error) {
      if (error instanceof AccountServiceError && (error.status === 400 || error.status === 401)) return this.signedOut();
      throw error;
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    for (const force of [false, true]) {
      const session = await this.fresh(force);
      const response = await this.fetch(new URL(path, session.service), {
        method,
        headers: { authorization: `Bearer ${session.access_token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 401 && !force) continue;
      if (response.status === 401) return this.signedOut();
      if (!response.ok) throw await failure(response);
      return response.status === 204 ? null : response.json();
    }
    return this.signedOut();
  }
}
