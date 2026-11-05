/**
 * A copy made in tmux, brought to the browsers that show it (#1517). herdr's attach stream drops
 * a pane's OSC 52 (herdrdev/herdr#4612), so tmux's `set-clipboard on` never reaches a browser.
 * A tmux hook the user adds (docs/guide.md) names the tmux socket and the pane that copied, never
 * the text, to a route only a program on this PC reaches. The server reads tmux's newest buffer
 * itself and tells it to the browsers showing a herdr pane whose tmux client shows the copying
 * pane's window: the clients tmux itself would have set the clipboard of.
 */
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { cameThroughProxy, isLoopbackAddress } from "./access.ts";
import { jsonResponse } from "./http.ts";

export const TMUX_COPIED_PATH = "/api/tmux/copied";
/** the header the hook sends: a page in a browser cannot add it without asking first (CORS) */
export const TMUX_HOOK_HEADER = "x-ovis-tmux-hook";
const TMUX_TIMEOUT_MS = 2000;
/** a bigger copy is dropped, as the client drops an OSC 52 write above MAX_OSC52_BYTES (src/lib/osc52.ts) */
export const MAX_TMUX_COPY_BYTES = 100 * 1024;

export interface TmuxCopyDeps {
  /** the tmux program to ask; `tmux` on PATH unless a test names another */
  tmux?: string;
  shownPanes(): Iterable<string>;
  /** the pids herdr names in the pane's terminal: its shell and foreground processes */
  panePids(paneId: string): Promise<number[]>;
  copy(paneId: string, text: string): void;
}

/**
 * Whether the request is the hook on this PC: a POST from loopback, straight to this server (no
 * proxy, a loopback Host), with the hook's header and no Origin, which every browser request carries.
 */
export function fromTmuxHook(request: Request, peer: string | null): boolean {
  return request.method === "POST" && peer !== null && isLoopbackAddress(peer) && !cameThroughProxy(request.headers)
    && request.headers.get(TMUX_HOOK_HEADER) === "1" && !request.headers.has("origin");
}

async function tmux(program: string, socket: string, args: string[], limit = 64 * 1024): Promise<string | null> {
  const child = Bun.spawn([program, "-S", socket, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: TMUX_TIMEOUT_MS });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of child.stdout) {
    size += chunk.byteLength;
    if (size > limit) {
      child.kill();
      return null;
    }
    chunks.push(chunk);
  }
  if (await child.exited !== 0) return null;
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** A socket this server's own user made: another user's tmux could hand it any text. */
function ownSocket(path: string): boolean {
  const uid = process.getuid?.();
  if (uid === undefined) return false;
  try {
    const stat = lstatSync(path);
    return stat.isSocket() && stat.uid === uid;
  } catch {
    return false;
  }
}

export async function handleTmuxCopied(request: Request, deps: TmuxCopyDeps): Promise<Response> {
  const form = await request.formData().catch(() => null);
  const socket = form?.get("socket");
  const pane = form?.get("pane");
  if (typeof socket !== "string" || !isAbsolute(socket) || typeof pane !== "string" || !/^%\d+$/.test(pane)) {
    return jsonResponse({ error: { code: "invalid_request", message: "socket must be an absolute path and pane a tmux pane id" } }, 400);
  }
  if (!ownSocket(socket)) return jsonResponse({ error: { code: "forbidden", message: "the tmux socket is not this user's" } }, 403);
  const program = deps.tmux ?? "tmux";
  let text: string | null;
  let window: string | null;
  let clients: string | null;
  try {
    // show-buffer without -b prints the newest buffer: the copy that ran the hook
    [text, window, clients] = await Promise.all([
      tmux(program, socket, ["show-buffer"], MAX_TMUX_COPY_BYTES),
      tmux(program, socket, ["display-message", "-p", "-t", pane, "#{window_id}"]),
      tmux(program, socket, ["list-clients", "-F", "#{client_pid}\t#{window_id}"]),
    ]);
  } catch {
    return jsonResponse({ error: { code: "tmux_unavailable", message: "tmux could not be run" } }, 503);
  }
  // nothing to copy, a copy too big for a browser's clipboard (as OSC 52 drops it), or a pane gone
  if (!text || window === null || clients === null) return new Response(null, { status: 204 });
  const shown = window.trim();
  const pids = new Set(clients.split("\n").flatMap((line) => {
    const [pid, at] = line.split("\t");
    return at === shown && pid && /^\d+$/.test(pid) ? [Number(pid)] : [];
  }));
  if (pids.size === 0) return new Response(null, { status: 204 });
  await Promise.all([...deps.shownPanes()].map(async (paneId) => {
    const own = await deps.panePids(paneId).catch(() => []);
    if (own.some((pid) => pids.has(pid))) deps.copy(paneId, text);
  }));
  return new Response(null, { status: 204 });
}
