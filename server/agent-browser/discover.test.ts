import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserEndpoint, type DiscoverDeps, discoverBrowser, type ProcessEntry, readTextOrNull, treeUnder, verifyEndpoint } from "./discover.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** a profile folder holding the DevToolsActivePort a browser listening on `port` writes */
function profile(port: number, id: string): string {
  const root = mkdtempSync(join(tmpdir(), "ovis-agent-browser-"));
  roots.push(root);
  const dir = join(root, "profile");
  mkdirSync(dir);
  writeFileSync(join(dir, "DevToolsActivePort"), `${port}\n/devtools/browser/${id}`);
  return dir;
}

/** the listeners that answer for a browser: each port and the browser id it would name */
function deps(processes: ProcessEntry[], listening: BrowserEndpoint[]): DiscoverDeps {
  return {
    descendants: async (root) => { const under = treeUnder(processes, root); return processes.filter((entry) => under.has(entry.pid)); },
    readText: readTextOrNull,
    verify: async (endpoint) => listening.some((listener) => listener.port === endpoint.port && listener.browserPath === endpoint.browserPath),
  };
}

const SHELL = 100;

it("finds the browser an agent under the pane's shell started on a port its profile names, not its helpers", async () => {
  const dir = profile(41001, "agent");
  const processes = [
    { pid: SHELL, ppid: 1, argv: ["bash"] },
    { pid: 101, ppid: SHELL, argv: ["node", "agent.js"] },
    // Chromium rewrites its own command line into one string joined with spaces
    { pid: 102, ppid: 101, argv: [`/opt/chromium dev/chrome --headless=new --remote-debugging-port=0 --user-data-dir=${dir}`] },
    { pid: 103, ppid: 102, argv: ["/opt/chromium/chrome", "--type=renderer", "--remote-debugging-port=0", `--user-data-dir=${dir}`] },
  ];
  expect(await discoverBrowser(SHELL, deps(processes, [{ port: 41001, browserPath: "/devtools/browser/agent" }])))
    .toEqual({ status: "live", pid: 102, endpoint: { port: 41001, browserPath: "/devtools/browser/agent" } });
});

it("never finds a browser outside the pane's process tree, such as the user's own", async () => {
  const dir = profile(41002, "user");
  const processes = [
    { pid: SHELL, ppid: 1, argv: ["bash"] },
    { pid: 200, ppid: 1, argv: ["/usr/bin/google-chrome", "--remote-debugging-port=41002", `--user-data-dir=${dir}`] },
  ];
  expect(await discoverBrowser(SHELL, deps(processes, [{ port: 41002, browserPath: "/devtools/browser/user" }]))).toEqual({ status: "none" });
});

it("refuses a port the profile's file does not prove: another listener, another port asked for, or no profile of its own", async () => {
  const dir = profile(41003, "stale");
  const processes = [
    { pid: SHELL, ppid: 1, argv: ["bash"] },
    // the file names a browser id no listener on that port answers with (another process holds the port)
    { pid: 301, ppid: SHELL, argv: ["chromium", "--remote-debugging-port=0", `--user-data-dir=${dir}`] },
    // asked for 9222, but its profile says it listens elsewhere
    { pid: 302, ppid: SHELL, argv: ["chromium", "--remote-debugging-port=9222", `--user-data-dir=${dir}`] },
    // no profile of its own: the user's default profile's file is never read
    { pid: 303, ppid: SHELL, argv: ["chromium", "--remote-debugging-port=9222"] },
  ];
  expect(await discoverBrowser(SHELL, deps(processes, [{ port: 41003, browserPath: "/devtools/browser/other" }]))).toEqual({ status: "none" });
});

it("tells a browser driven over a pipe apart from no browser", async () => {
  const processes = [
    { pid: SHELL, ppid: 1, argv: ["bash"] },
    { pid: 401, ppid: SHELL, argv: ["/home/u/.cache/ms-playwright/chromium-1243/chrome-linux/chrome", "--remote-debugging-pipe", "--user-data-dir=/tmp/playwright"] },
  ];
  expect(await discoverBrowser(SHELL, deps(processes, []))).toEqual({ status: "pipe-only" });
});

it("proves a listener only when it names the browser id the profile's file named", async () => {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1/devtools/browser/actual" }) });
  try {
    const port = server.port ?? 0;
    expect(await verifyEndpoint({ port, browserPath: "/devtools/browser/actual" })).toBe(true);
    expect(await verifyEndpoint({ port, browserPath: "/devtools/browser/claimed" })).toBe(false);
  } finally {
    await server.stop(true);
  }
});
