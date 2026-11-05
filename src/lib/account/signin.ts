/**
 * Signing in with GitHub or Apple through the account service: OAuth's authorization code with
 * PKCE, the service standing between this client and the provider. The service sends the browser
 * back with the code in the fragment, which no request carries, so the code never reaches the
 * host that serves the app.
 */
import { toBase64Url } from "../../../shared/relay-pair-sas.ts";
import { requestToken } from "./service.ts";
import type { AccountProvider, AccountSession, AccountStore } from "./store.ts";

/** A sign-in left at the provider's pages longer than this is not finished: its return is refused. */
export const SIGN_IN_MS = 10 * 60_000;

export class SignInError extends Error {
  constructor(readonly code: "no_sign_in" | "state_mismatch" | "expired" | "denied", message: string) {
    super(message);
    this.name = "SignInError";
  }
}

type Fetch = (input: Request | string | URL, init?: RequestInit) => Promise<Response>;

function random(bytes: number): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Where to send the browser to sign in; the verifier and state wait in the store for the return. */
export async function beginSignIn(provider: AccountProvider, options: { store: AccountStore; service: string; redirectUri: string; now?: () => number }): Promise<string> {
  const verifier = random(32);
  const state = random(16);
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  await options.store.set("pending", { service: options.service, provider, state, verifier, redirect_uri: options.redirectUri, started_at: (options.now ?? Date.now)() });
  const url = new URL(`/v1/signin/${provider}`, options.service);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

export type SignInReturn = { code: string; state: string } | { error: string; state: string };

/** The sign-in a fragment (or a native callback's query) brings back, or null when it is not one. */
export function signInReturn(params: string): SignInReturn | null {
  const fields = new URLSearchParams(params.replace(/^[#?]/, ""));
  const state = fields.get("state");
  if (state === null) return null;
  const code = fields.get("code");
  if (code !== null) return { code, state };
  const error = fields.get("error");
  return error === null ? null : { error, state };
}

/**
 * Trades the returned code for a session, once: the waiting sign-in goes whatever the outcome, so
 * a return opened twice, or one for another sign-in, does nothing.
 */
export async function finishSignIn(returned: SignInReturn, options: { store: AccountStore; fetch?: Fetch; now?: () => number }): Promise<AccountSession> {
  const now = options.now ?? Date.now;
  const pending = await options.store.get("pending");
  await options.store.set("pending", undefined);
  if (pending === undefined) throw new SignInError("no_sign_in", "No sign-in was waiting");
  if (pending.state !== returned.state) throw new SignInError("state_mismatch", "This sign-in was not started here");
  if (now() - pending.started_at > SIGN_IN_MS) throw new SignInError("expired", "The sign-in took too long");
  if ("error" in returned) throw new SignInError("denied", "The sign-in was cancelled or refused");
  const session = await requestToken(pending.service, {
    grant_type: "authorization_code", code: returned.code, code_verifier: pending.verifier, redirect_uri: pending.redirect_uri,
  }, { ...(options.fetch ? { fetch: options.fetch } : {}), now });
  await options.store.set("session", session);
  return session;
}
