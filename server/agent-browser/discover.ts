/**
 * Finds the browser an agent in a pane drives, for the agent browser panel (server/core/agent-browser.ts): a
 * Chromium-family browser started under the pane's shell, with a DevTools port it wrote to its own profile's
 * `DevToolsActivePort`. Only the pane's own process tree is read, so a browser the user runs elsewhere is never
 * found, and the port is taken from the file the browser wrote once it listened, then proved by asking the
 * listener for the same browser id: a port a browser only asked for (and another process holds) is never used.
 * A browser driven over `--remote-debugging-pipe` (Playwright's and chrome-devtools-mcp's own launches) has no
 * port to find: it is reported as `pipe-only`, so the panel can say why nothing shows.
 */
import { readdir, readFile, readlink } from "node:fs/promises";
import { basename, join } from "node:path";

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly argv: readonly string[];
}

/** A browser's DevTools listener on loopback: its port and its browser target's path, `/devtools/browser/<id>`. */
export interface BrowserEndpoint {
  readonly port: number;
  readonly browserPath: string;
}

export type BrowserDiscovery =
  | { readonly status: "none" }
  | { readonly status: "pipe-only" }
  | { readonly status: "live"; readonly pid: number; readonly endpoint: BrowserEndpoint };

export interface DiscoverDeps {
  /** the processes under `root` (the pane's shell included) */
  readonly descendants: (root: number) => Promise<readonly ProcessEntry[]>;
  readonly readText: (path: string) => Promise<string | null>;
  /**
   * whether the loopback listener on the endpoint's port is held by process `pid` itself and names the browser
   * target path its profile's file named: a profile file can name any browser (a symlinked profile, a stale file),
   * but only the browser process holds its own listening socket
   */
  readonly verify: (endpoint: BrowserEndpoint, pid: number) => Promise<boolean>;
}

const BROWSER_NAME = /^(?:google-chrome(?:-[a-z]+)?|chrome|chromium(?:-browser)?|chrome-headless-shell|headless_shell|msedge|microsoft-edge(?:-[a-z]+)?|brave(?:-browser)?|google chrome(?: [a-z]+)?|chromium|microsoft edge|brave browser)(?:\.exe)?$/i;
const BROWSER_PATH = /^\/devtools\/browser\/[A-Za-z0-9-]+$/;

function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  return argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

/**
 * argv whole: Chromium rewrites its own /proc/<pid>/cmdline into one string joined with spaces, as macOS's `ps`
 * column does, so a lone argument is split before each ` --` flag (the program's path may hold spaces).
 */
export function wholeArgv(argv: readonly string[]): readonly string[] {
  const [only] = argv;
  return argv.length === 1 && only !== undefined ? only.split(/ (?=--)/) : argv;
}

/** A Chromium browser's main process: a known browser program that is none of its helpers (`--type=renderer`, …). */
export function isBrowserMain(entry: ProcessEntry): boolean {
  const program = entry.argv[0];
  if (program === undefined) return false;
  return BROWSER_NAME.test(basename(program)) && flag(entry.argv, "type") === undefined;
}

/** The port and path in a `DevToolsActivePort` file, or null when it does not hold one. */
export function parseActivePort(text: string): BrowserEndpoint | null {
  const [portLine, pathLine] = text.split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || pathLine === undefined || !BROWSER_PATH.test(pathLine)) return null;
  return { port, browserPath: pathLine };
}

/** What one browser main process offers: its endpoint as its profile names it, pipe-only, or nothing to use. */
async function endpointOf(entry: ProcessEntry, deps: DiscoverDeps): Promise<BrowserEndpoint | "pipe" | null> {
  const asked = flag(entry.argv, "remote-debugging-port");
  if (asked === undefined) return entry.argv.includes("--remote-debugging-pipe") ? "pipe" : null;
  // without its own profile a browser joins the user's default one: never that
  const profile = flag(entry.argv, "user-data-dir");
  if (profile === undefined || profile === "") return null;
  const text = await deps.readText(join(profile, "DevToolsActivePort"));
  const endpoint = text === null ? null : parseActivePort(text);
  if (endpoint === null) return null;
  if (asked !== "0" && Number(asked) !== endpoint.port) return null;
  return endpoint;
}

/** The first browser under the pane's shell whose DevTools listener is proved, else whether one is pipe-only. */
export async function discoverBrowser(shellPid: number, deps: DiscoverDeps): Promise<BrowserDiscovery> {
  const browsers = (await deps.descendants(shellPid)).map((entry) => ({ ...entry, argv: wholeArgv(entry.argv) })).filter(isBrowserMain).sort((a, b) => a.pid - b.pid);
  let pipeOnly = false;
  for (const browser of browsers) {
    const endpoint = await endpointOf(browser, deps);
    if (endpoint === "pipe") { pipeOnly = true; continue; }
    if (endpoint !== null && await deps.verify(endpoint, browser.pid)) return { status: "live", pid: browser.pid, endpoint };
  }
  return pipeOnly ? { status: "pipe-only" } : { status: "none" };
}

/** The entries under `root`, `root` included, from a flat process list. */
export function treeUnder(entries: readonly { readonly pid: number; readonly ppid: number }[], root: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const list = children.get(entry.ppid);
    if (list) list.push(entry.pid);
    else children.set(entry.ppid, [entry.pid]);
  }
  const found = new Set<number>([root]);
  const queue = [root];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    for (const child of children.get(pid) ?? []) {
      if (!found.has(child)) { found.add(child); queue.push(child); }
    }
  }
  return found;
}

function gone(error: unknown): boolean {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  return code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM";
}

/** Linux: every process's parent from /proc/<pid>/stat, then the command lines of those under `root` only. */
async function linuxDescendants(root: number): Promise<ProcessEntry[]> {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name)).map(Number);
  const parents = (await Promise.all(pids.map(async (pid) => {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return { pid, ppid: Number(stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[1]) };
    } catch (error) {
      if (gone(error)) return null;
      throw error;
    }
  }))).filter((entry) => entry !== null);
  const under = treeUnder(parents, root);
  return (await Promise.all(parents.filter((entry) => under.has(entry.pid)).map(async (entry) => {
    try {
      return { ...entry, argv: (await readFile(`/proc/${entry.pid}/cmdline`, "utf8")).split("\0").filter((arg) => arg !== "") };
    } catch (error) {
      if (gone(error)) return null;
      throw error;
    }
  }))).filter((entry) => entry !== null);
}

/** macOS: `ps`, run as a child without blocking the event loop; its command column is argv joined (wholeArgv). */
async function darwinDescendants(root: number): Promise<ProcessEntry[]> {
  const child = Bun.spawn(["/bin/ps", "-axww", "-o", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  const all = text.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), argv: [match[3] ?? ""] }];
  });
  const under = treeUnder(all, root);
  return all.filter((entry) => under.has(entry.pid));
}

/** The processes under `root` on this OS; none on Windows, where the panel finds no browser yet. */
export function processDescendants(root: number): Promise<readonly ProcessEntry[]> {
  if (process.platform === "linux") return linuxDescendants(root);
  if (process.platform === "darwin") return darwinDescendants(root);
  return Promise.resolve([]);
}

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (gone(error)) return null;
    throw error;
  }
}

/** Linux: whether `pid` holds a listening TCP socket on `port` (its net table's inode among its own descriptors). */
export async function linuxOwnsPort(pid: number, port: number): Promise<boolean> {
  const inodes = new Set<string>();
  for (const table of ["tcp", "tcp6"]) {
    for (const line of (await readTextOrNull(`/proc/${pid}/net/${table}`))?.split("\n").slice(1) ?? []) {
      const fields = line.trim().split(/\s+/);
      const local = fields[1]?.split(":")[1];
      // st 0A is LISTEN; the local address's port is hex
      if (fields[3] === "0A" && local !== undefined && Number.parseInt(local, 16) === port && fields[9] !== undefined) inodes.add(`socket:[${fields[9]}]`);
    }
  }
  if (inodes.size === 0) return false;
  let descriptors: string[];
  try { descriptors = await readdir(`/proc/${pid}/fd`); } catch (error) {
    if (gone(error)) return false;
    throw error;
  }
  for (const descriptor of descriptors) {
    try {
      if (inodes.has(await readlink(`/proc/${pid}/fd/${descriptor}`))) return true;
    } catch (error) {
      if (!gone(error)) throw error;
    }
  }
  return false;
}

/** macOS: whether `pid` holds a listening TCP socket on `port`, as lsof reads the kernel's table. */
async function darwinOwnsPort(pid: number, port: number): Promise<boolean> {
  const child = Bun.spawn(["/usr/sbin/lsof", "-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text.split("\n").some((line) => line.trim() === String(pid));
}

export function ownsPort(pid: number, port: number): Promise<boolean> {
  if (process.platform === "linux") return linuxOwnsPort(pid, port);
  if (process.platform === "darwin") return darwinOwnsPort(pid, port);
  return Promise.resolve(false);
}

/** Proved when the browser process holds the listener and the listener names the path the profile's file named. */
export async function verifyEndpoint(endpoint: BrowserEndpoint, pid: number): Promise<boolean> {
  if (!await ownsPort(pid, endpoint.port)) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/json/version`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    const url = typeof body === "object" && body !== null && "webSocketDebuggerUrl" in body ? body.webSocketDebuggerUrl : undefined;
    return typeof url === "string" && URL.canParse(url) && new URL(url).pathname === endpoint.browserPath;
  } catch (error) {
    // nothing listens, it answered something else, or it was too slow: not this browser
    if (error instanceof TypeError || error instanceof SyntaxError || (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError"))) return false;
    throw error;
  }
}

export const discoverDeps: DiscoverDeps = { descendants: processDescendants, readText: readTextOrNull, verify: verifyEndpoint };
