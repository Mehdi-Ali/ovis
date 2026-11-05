/**
 * A copy made in tmux, brought to the browsers that show it (#1517). herdr's attach stream drops
 * a pane's OSC 52 (herdrdev/herdr#4612), so tmux's clipboard writes never reach a browser.
 *
 * Only while the shared `tmuxCopy` setting is on (off by default): for each pane some browser shows
 * whose foreground process is a tmux client, this server sets one indexed `pane-set-clipboard` hook
 * on that client's tmux server at runtime, and unsets it once no shown pane runs that tmux, the
 * setting goes off or the server stops. No file of the user's (`~/.tmux.conf` or any other) is ever
 * written, and the user's own hooks on that event stay, as the hook takes an index of its own.
 *
 * The hook POSTs only the tmux socket and the copying pane (never the text) to a route that takes
 * nothing but a loopback peer (127.0.0.1 or ::1, no proxy) carrying this server's secret, read by curl
 * from a 0600 file in the state folder, so neither another user on the PC nor a page in a browser can
 * post a copy. The server then reads tmux's newest buffer itself and tells it to the browsers showing
 * a pane whose tmux client shows the copying pane's window: the clients tmux itself would set.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { cameThroughProxy } from "./access.ts";
import { jsonResponse } from "./http.ts";

export const TMUX_COPIED_PATH = "/api/tmux/copied";
export const TMUX_HOOK_HEADER = "x-ovis-tmux-hook";
const TMUX_TIMEOUT_MS = 2000;
/** a bigger copy is dropped, as the client drops an OSC 52 write above MAX_OSC52_BYTES (src/lib/osc52.ts) */
export const MAX_TMUX_COPY_BYTES = 100 * 1024;
/** how often the shown panes are looked at again for a tmux started, ended or left since */
const SWEEP_MS = 3000;
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** a path the hook names inside tmux's and the shell's quoting; anything else is not hooked */
const PLAIN_PATH = /^\/[\w./-]+$/;

export interface TmuxForeground { pid?: number | null; argv?: string[] | null }

export interface TmuxCopyOptions {
  stateDir: string;
  /** the port this server listens on, the one the hook posts to on 127.0.0.1 */
  port(): number | undefined;
  enabled(): boolean;
  /** calls back when the setting may have changed; answers the unsubscribe */
  subscribe(listener: () => void): () => void;
  shownPanes(): Iterable<string>;
  /** the pane's foreground processes, as herdr's `pane.process_info` names them */
  foreground(paneId: string): Promise<TmuxForeground[]>;
  copy(paneId: string, text: string): void;
  /** the tmux and curl programs; found on PATH unless a test names others */
  tmux?: string | null;
  curl?: string | null;
  sweepMs?: number;
}

async function run(program: string, args: string[], limit = 64 * 1024): Promise<string | null> {
  const child = Bun.spawn([program, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: TMUX_TIMEOUT_MS });
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

/**
 * The socket a tmux client's argv connects to: `-S path`, else `-L name` (or `default`) in
 * `$TMUX_TMPDIR/tmux-<uid>/`, as tmux itself picks it. Null when the argv is not a tmux client.
 */
export function tmuxSocketOf(argv: readonly string[], tmpdir: string, uid: number): string | null {
  if (argv.length === 0 || basename(argv[0]!) !== "tmux") return null;
  let path: string | null = null;
  let name = "default";
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i]!;
    if (word === "--" || !word.startsWith("-") || word === "-") break;
    for (let at = 1; at < word.length; at++) {
      const flag = word[at]!;
      if (!"cfLST".includes(flag)) continue;
      const value = at + 1 < word.length ? word.slice(at + 1) : argv[++i];
      if (value === undefined) return null;
      if (flag === "S") path = value;
      if (flag === "L") name = value;
      break;
    }
  }
  return path ?? join(tmpdir, `tmux-${uid}`, name);
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

/** TMUX_TMPDIR as the client process has it (Linux), else as this server has it. */
function clientTmpdir(pid: number): string {
  try {
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    const found = environ.find((entry) => entry.startsWith("TMUX_TMPDIR="))?.slice(12);
    if (found) return found;
  } catch {}
  return process.env["TMUX_TMPDIR"] || "/tmp";
}

export class TmuxCopyHooks {
  private readonly secret = randomBytes(32).toString("hex");
  private readonly headerFile: string;
  private readonly tmux: string | null;
  private readonly curl: string | null;
  /** the shown panes that run a tmux client: its pid and its server's socket (real path) */
  private readonly panes = new Map<string, { pid: number; socket: string }>();
  /** the sockets whose tmux has this server's hook now */
  private readonly hooked = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly unsubscribe: () => void;
  private sweeping: Promise<void> | null = null;
  private again = false;
  private stopped = false;

  constructor(private readonly options: TmuxCopyOptions) {
    this.headerFile = join(options.stateDir, "tmux-hook-header");
    this.tmux = options.tmux === undefined ? Bun.which("tmux") : options.tmux;
    this.curl = options.curl === undefined ? Bun.which("curl") : options.curl;
    this.timer = setInterval(() => void this.sweep(), options.sweepMs ?? SWEEP_MS);
    this.timer.unref();
    this.unsubscribe = options.subscribe(() => void this.sweep());
  }

  /** the hook's array index: one per server port, so two servers on this PC never unset each other's */
  private index(): number | null {
    const port = this.options.port();
    return port === undefined || port <= 0 ? null : port;
  }

  /** Looks at the shown panes again and sets or unsets the hooks to match. Settles once it is done. */
  sweep(): Promise<void> {
    if (this.sweeping) {
      this.again = true;
      return this.sweeping;
    }
    this.sweeping = (async () => {
      do {
        this.again = false;
        await this.reconcile().catch((error: unknown) => console.error(`tmux copy: ${error instanceof Error ? error.message : String(error)}`));
      } while (this.again && !this.stopped);
    })().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  private async reconcile(): Promise<void> {
    const on = !this.stopped && this.options.enabled() && this.tmux !== null && process.platform !== "win32";
    const shown = on ? new Set(this.options.shownPanes()) : new Set<string>();
    for (const paneId of this.panes.keys()) if (!shown.has(paneId)) this.panes.delete(paneId);
    await Promise.all([...shown].map(async (paneId) => {
      const client = (await this.options.foreground(paneId).catch(() => [])).find((process) =>
        typeof process.pid === "number" && Array.isArray(process.argv) && basename(process.argv[0] ?? "") === "tmux");
      if (!client) {
        this.panes.delete(paneId);
        return;
      }
      const pid = client.pid!;
      if (this.panes.get(paneId)?.pid === pid) return;
      const socket = await this.clientSocket(pid, client.argv!);
      if (socket === null) this.panes.delete(paneId);
      else this.panes.set(paneId, { pid, socket });
    }));
    const wanted = new Set([...this.panes.values()].map((pane) => pane.socket));
    await Promise.all([
      ...[...wanted].filter((socket) => !this.hooked.has(socket)).map((socket) => this.install(socket)),
      ...[...this.hooked].filter((socket) => !wanted.has(socket)).map((socket) => this.uninstall(socket)),
    ]);
  }

  /** The real path of the tmux socket the client `pid` is attached to, checked with that tmux; null when it is not attached there. */
  private async clientSocket(pid: number, argv: string[]): Promise<string | null> {
    const uid = process.getuid?.();
    if (uid === undefined) return null;
    const named = tmuxSocketOf(argv, clientTmpdir(pid), uid);
    if (named === null || !isAbsolute(named)) return null;
    let socket: string;
    try { socket = realpathSync(named); } catch { return null; }
    if (!ownSocket(socket)) return null;
    const clients = await run(this.tmux!, ["-S", socket, "list-clients", "-F", "#{client_pid}"]);
    return clients?.split("\n").includes(String(pid)) ? socket : null;
  }

  private async install(socket: string): Promise<void> {
    const index = this.index();
    if (index === null || this.curl === null || !PLAIN_PATH.test(this.headerFile) || !PLAIN_PATH.test(this.curl)) return;
    writeFileSync(this.headerFile, `${TMUX_HOOK_HEADER}: ${this.secret}\n`, { mode: 0o600 });
    chmodSync(this.headerFile, 0o600);
    const post = `${this.curl} -fsS -m 2 -o /dev/null -H @${this.headerFile} --data-urlencode socket=#{q:socket_path} --data-urlencode pane=#{pane_id} http://127.0.0.1:${index}${TMUX_COPIED_PATH} || true`;
    if (await run(this.tmux!, ["-S", socket, "set-hook", "-g", `pane-set-clipboard[${index}]`, `run-shell -b "${post}"`]) !== null) this.hooked.add(socket);
  }

  private async uninstall(socket: string): Promise<void> {
    this.hooked.delete(socket);
    const index = this.index();
    if (index !== null) await run(this.tmux!, ["-S", socket, "set-hook", "-gu", `pane-set-clipboard[${index}]`]);
  }

  /** Unsets every hook this server set; settles once tmux has answered. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe();
    await this.sweeping;
    this.panes.clear();
    await Promise.all([...this.hooked].map((socket) => this.uninstall(socket)));
  }

  /** Whether the request is this server's hook: a POST from 127.0.0.1 or ::1, straight to it, with its secret and no Origin. */
  fromHook(request: Request, peer: string | null): boolean {
    if (request.method !== "POST" || peer === null || !LOOPBACK_PEERS.has(peer) || cameThroughProxy(request.headers) || request.headers.has("origin")) return false;
    const presented = Buffer.from(request.headers.get(TMUX_HOOK_HEADER) ?? "");
    const secret = Buffer.from(this.secret);
    return presented.byteLength === secret.byteLength && timingSafeEqual(presented, secret);
  }

  async handle(request: Request, peer: string | null): Promise<Response> {
    if (!this.fromHook(request, peer)) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
    const form = await request.formData().catch(() => null);
    const named = form?.get("socket");
    const pane = form?.get("pane");
    if (typeof named !== "string" || !isAbsolute(named) || typeof pane !== "string" || !/^%\d+$/.test(pane)) {
      return jsonResponse({ error: { code: "invalid_request", message: "socket must be an absolute path and pane a tmux pane id" } }, 400);
    }
    let socket: string;
    try { socket = realpathSync(named); } catch { socket = named; }
    if (!this.hooked.has(socket) || !ownSocket(socket)) return jsonResponse({ error: { code: "forbidden", message: "this server set no hook on that tmux" } }, 403);
    // show-buffer without -b prints the newest buffer: the copy that ran the hook
    const [text, window, clients] = await Promise.all([
      run(this.tmux!, ["-S", socket, "show-buffer"], MAX_TMUX_COPY_BYTES),
      run(this.tmux!, ["-S", socket, "display-message", "-p", "-t", pane, "#{window_id}"]),
      run(this.tmux!, ["-S", socket, "list-clients", "-F", "#{client_pid}\t#{window_id}"]),
    ]);
    // nothing to copy, a copy too big for a browser's clipboard (as OSC 52 drops it), or a pane gone
    if (!text || window === null || clients === null) return new Response(null, { status: 204 });
    const shown = window.trim();
    const pids = new Set(clients.split("\n").flatMap((line) => {
      const [pid, at] = line.split("\t");
      return at === shown && pid && /^\d+$/.test(pid) ? [Number(pid)] : [];
    }));
    const showing = new Set(this.options.shownPanes());
    for (const [paneId, client] of this.panes) {
      if (client.socket === socket && pids.has(client.pid) && showing.has(paneId)) this.options.copy(paneId, text);
    }
    return new Response(null, { status: 204 });
  }
}
