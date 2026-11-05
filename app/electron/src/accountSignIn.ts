/**
 * Signing in to the account from the desktop app (docs/account.md, "Signing in"): the provider's
 * page opens in the system browser, and the account service sends it back to a server on this
 * machine's loopback address, `http://127.0.0.1:<port>/callback`, with the code and state in the
 * query (RFC 8252). The page itself finishes the sign-in, as in a browser; this only carries the
 * return. One sign-in at a time; a new one ends the one before.
 */
import { createServer, type Server } from "node:http";

/** A sign-in left at the provider's pages longer than this is given up. */
export const SIGN_IN_MS = 10 * 60_000;

const CLOSED_PAGE = "<!doctype html><meta charset=\"utf-8\"><title>Ovis</title><p style=\"font:16px system-ui;margin:3em;text-align:center\">You're signed in. You can close this tab and go back to Ovis.</p>";

export interface LoopbackSignIn {
  /** where the account service sends the browser back */
  readonly redirectUri: string;
  /** the callback's query (`code=…&state=…`, or `error=…&state=…`), once the browser comes back */
  readonly returned: Promise<string>;
  close(): void;
}

let current: LoopbackSignIn | null = null;

export async function startLoopbackSignIn(timeoutMs = SIGN_IN_MS): Promise<LoopbackSignIn> {
  current?.close();
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    // only the callback, with a state, ends the wait: anything else that finds the port is turned away
    if (request.method !== "GET" || url.pathname !== "/callback" || !url.searchParams.has("state")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(CLOSED_PAGE);
    resolve(url.search.slice(1));
    close();
  });
  const timer = setTimeout(() => { reject(new Error("The sign-in took too long")); close(); }, timeoutMs);
  const close = (): void => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    reject(new Error("The sign-in was replaced or cancelled"));
    if (current === signIn) current = null;
  };
  await new Promise<void>((listening, failed) => { server.once("error", failed); server.listen(0, "127.0.0.1", () => listening()); });
  const address = server.address();
  if (address === null || typeof address === "string") { close(); throw new Error("The sign-in server has no port"); }
  // the caller awaits `returned` only after opening the browser: a rejection meanwhile is not unhandled
  promise.catch(() => undefined);
  const signIn: LoopbackSignIn = { redirectUri: `http://127.0.0.1:${address.port}/callback`, returned: promise, close };
  current = signIn;
  return signIn;
}
