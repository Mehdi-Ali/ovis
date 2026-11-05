import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromTmuxHook, handleTmuxCopied, MAX_TMUX_COPY_BYTES, TMUX_HOOK_HEADER, type TmuxCopyDeps } from "./tmux-clipboard.ts";

const hook = (headers: Record<string, string>, method = "POST") =>
  new Request("http://127.0.0.1:7317/api/tmux/copied", { method, headers: { host: "127.0.0.1:7317", [TMUX_HOOK_HEADER]: "1", ...headers } });

describe("who may say tmux copied", () => {
  it("lets in only the hook's own request from this PC", () => {
    expect(fromTmuxHook(hook({}), "127.0.0.1")).toBeTrue();
    expect(fromTmuxHook(hook({}), "::1")).toBeTrue();
    // another device, a proxy in between (tailscale serve), a browser page, a missing header, a read
    expect(fromTmuxHook(hook({}), "100.64.0.9")).toBeFalse();
    expect(fromTmuxHook(hook({}), null)).toBeFalse();
    expect(fromTmuxHook(hook({ "x-forwarded-for": "100.64.0.9" }), "127.0.0.1")).toBeFalse();
    expect(fromTmuxHook(hook({ host: "home.tailnet.ts.net" }), "127.0.0.1")).toBeFalse();
    expect(fromTmuxHook(hook({ origin: "http://127.0.0.1:7317" }), "127.0.0.1")).toBeFalse();
    expect(fromTmuxHook(new Request("http://127.0.0.1:7317/api/tmux/copied", { method: "POST", headers: { host: "127.0.0.1:7317" } }), "127.0.0.1")).toBeFalse();
    expect(fromTmuxHook(hook({}, "GET"), "127.0.0.1")).toBeFalse();
  });
});

const tmuxProgram = Bun.which("tmux");

describe.skipIf(tmuxProgram === null || process.platform === "win32")("a tmux copy", () => {
  const tmux = tmuxProgram!;
  let dir: string;
  let socket: string;
  let client: Bun.Subprocess;
  let clientPid: number;

  const run = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn([tmux, "-S", socket, ...args], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (code !== 0) throw new Error(`tmux ${args.join(" ")} failed: ${await new Response(child.stderr).text()}`);
    return out.trim();
  };
  const post = (fields: Record<string, string>) =>
    new Request("http://127.0.0.1:7317/api/tmux/copied", { method: "POST", body: new URLSearchParams(fields) });
  const deps = (pids: Record<string, number[]>, copies: [string, string][]): TmuxCopyDeps => ({
    tmux,
    shownPanes: () => Object.keys(pids),
    panePids: async (paneId) => pids[paneId] ?? [],
    copy: (paneId, text) => { copies.push([paneId, text]); },
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ovis-tmux-copy-"));
    socket = join(dir, "sock");
    writeFileSync(join(dir, "conf"), "set -g set-clipboard on\n");
    await run("-f", join(dir, "conf"), "new-session", "-d", "-s", "one", "-x", "80", "-y", "24", "sh");
    await run("new-window", "-d", "-t", "one", "sh");
    // a client in a pty, as a herdr pane running `tmux attach` holds one; it draws once it is attached
    const drawn = Promise.withResolvers<void>();
    client = Bun.spawn([tmux, "-S", socket, "attach", "-t", "one"], { env: { ...process.env, TERM: "xterm-256color" }, terminal: { cols: 80, rows: 24, data: () => drawn.resolve() } });
    clientPid = client.pid;
    await drawn.promise;
    expect((await run("list-clients", "-F", "#{client_pid}")).split("\n")).toContain(String(clientPid));
  });

  afterAll(async () => {
    client?.kill();
    await run("kill-server").catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("goes to the pane whose tmux client shows the copying pane's window, and to no other", async () => {
    const shown = await run("display-message", "-p", "-t", "one:0", "#{pane_id}");
    await run("set-buffer", "copied in tmux ✓");
    const copies: [string, string][] = [];
    const response = await handleTmuxCopied(post({ socket, pane: shown }), deps({ "pane-tmux": [4242, clientPid], "pane-shell": [1] }, copies));
    expect(response.status).toBe(204);
    expect(copies).toEqual([["pane-tmux", "copied in tmux ✓"]]);
  });

  it("goes nowhere for a pane in a window no client shows", async () => {
    const hidden = await run("display-message", "-p", "-t", "one:1", "#{pane_id}");
    await run("set-buffer", "from the window behind");
    const copies: [string, string][] = [];
    expect((await handleTmuxCopied(post({ socket, pane: hidden }), deps({ "pane-tmux": [clientPid] }, copies))).status).toBe(204);
    expect(copies).toEqual([]);
  });

  it("drops a copy too big for the clipboard, as an OSC 52 write that big is dropped", async () => {
    const shown = await run("display-message", "-p", "-t", "one:0", "#{pane_id}");
    const big = join(dir, "big");
    writeFileSync(big, "x".repeat(MAX_TMUX_COPY_BYTES + 1));
    await run("load-buffer", big);
    const copies: [string, string][] = [];
    expect((await handleTmuxCopied(post({ socket, pane: shown }), deps({ "pane-tmux": [clientPid] }, copies))).status).toBe(204);
    expect(copies).toEqual([]);
  });

  it("never asks a socket that is not a socket of this user, nor takes a malformed request", async () => {
    const file = join(dir, "not-a-socket");
    writeFileSync(file, "");
    const copies: [string, string][] = [];
    const answers = await Promise.all([
      handleTmuxCopied(post({ socket: file, pane: "%0" }), deps({ "pane-tmux": [clientPid] }, copies)),
      handleTmuxCopied(post({ socket: "relative/sock", pane: "%0" }), deps({ "pane-tmux": [clientPid] }, copies)),
      handleTmuxCopied(post({ socket, pane: "one:0" }), deps({ "pane-tmux": [clientPid] }, copies)),
    ]);
    expect(answers.map((answer) => answer.status)).toEqual([403, 400, 400]);
    expect(copies).toEqual([]);
  });
});
