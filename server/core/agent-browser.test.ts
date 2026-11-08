import { afterEach, expect, it } from "bun:test";
import type { Server } from "bun";
import type { ServerMessage } from "../../shared/protocol.ts";
import { type AgentBrowserDeps, createAgentBrowser } from "./agent-browser.ts";
import { type Client, connectionData } from "./connections.ts";

const WAIT_MS = 5000;

/** resolves once `ready()` holds after a change `subscribe` reports, or fails after WAIT_MS */
function until<T>(subscribe: (wake: () => void) => () => void, ready: () => T | undefined, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const first = ready();
    if (first !== undefined) { resolve(first); return; }
    const timer = setTimeout(() => { stop(); reject(new Error(`timed out waiting for ${what}`)); }, WAIT_MS);
    const stop = subscribe(() => {
      const value = ready();
      if (value === undefined) return;
      clearTimeout(timer);
      stop();
      resolve(value);
    });
  });
}

class Signal {
  private readonly listeners = new Set<() => void>();
  subscribe = (wake: () => void): (() => void) => { this.listeners.add(wake); return () => this.listeners.delete(wake); };
  fire(): void { for (const wake of [...this.listeners]) wake(); }
}

/** A page's DevTools endpoint: answers commands, sends one screencast frame on start, and records what it was told. */
class FakeBrowser {
  readonly told: { method: string; params: Record<string, unknown> }[] = [];
  readonly changed = new Signal();
  open = 0;
  readonly server: Server<undefined>;
  private socket: { send(data: string): void; close(): void } | null = null;
  tabs = [{ type: "page", id: "tab-1", title: "Shop", url: "https://shop.example.com/cart" }];
  /** what /json/list answers: the tabs, unless a test hands it its own body */
  listBody: unknown = null;

  constructor() {
    this.server = Bun.serve<undefined>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, server) => {
        const url = new URL(request.url);
        if (url.pathname === "/json/list") return Response.json(this.listBody ?? this.tabs);
        if (url.pathname.startsWith("/devtools/page/") && server.upgrade(request, { data: undefined })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open: (socket) => { this.socket = socket; this.open++; this.changed.fire(); },
        close: () => { this.open--; this.changed.fire(); },
        message: (socket, raw) => {
          const message = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> };
          this.told.push({ method: message.method, params: message.params });
          if (message.method === "Page.getFrameTree") {
            socket.send(JSON.stringify({ id: message.id, result: { frameTree: { frame: { id: "main", url: this.tabs[0]?.url } } } }));
            this.changed.fire();
            return;
          }
          socket.send(JSON.stringify({ id: message.id, result: {} }));
          if (message.method === "Page.startScreencast") {
            socket.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: "SlBFRw==", sessionId: 7, metadata: { deviceWidth: 1280, deviceHeight: 720 } } }));
          }
          this.changed.fire();
        },
      },
    });
  }

  get port(): number { return this.server.port ?? 0; }
  /** a DevTools event from the page, as the browser sends one */
  emit(method: string, params: Record<string, unknown>): void { this.socket?.send(JSON.stringify({ method, params })); }
  /** the page's DevTools connection ends, as when its tab closes */
  dropPage(): void { this.socket?.close(); }
  told_(method: string): Promise<Record<string, unknown>> {
    return until(this.changed.subscribe, () => this.told.find((entry) => entry.method === method)?.params, method);
  }
}

class FakeClient {
  readonly frames: ServerMessage[] = [];
  readonly changed = new Signal();
  readonly socket: Client;
  constructor(readOnly = false, browserOwner = true) {
    this.socket = {
      data: connectionData({ deviceId: undefined, readOnly, browserOwner }),
      readyState: WebSocket.OPEN,
      getBufferedAmount: () => 0,
      close: () => {},
      send: (raw: string) => { this.frames.push(JSON.parse(raw) as ServerMessage); this.changed.fire(); return 1; },
    };
  }
  next<K extends ServerMessage["type"]>(type: K, where: (frame: Extract<ServerMessage, { type: K }>) => boolean = () => true): Promise<Extract<ServerMessage, { type: K }>> {
    const seen = this.frames.length;
    return until(this.changed.subscribe, () => this.frames.slice(seen).find((frame): frame is Extract<ServerMessage, { type: K }> => frame.type === type && where(frame as Extract<ServerMessage, { type: K }>)), type);
  }
  last<K extends ServerMessage["type"]>(type: K): Extract<ServerMessage, { type: K }> | undefined {
    return [...this.frames].reverse().find((frame): frame is Extract<ServerMessage, { type: K }> => frame.type === type);
  }
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function harness({ enabled = true, pollMs = 60_000 }: { enabled?: boolean; pollMs?: number } = {}) {
  const browser = new FakeBrowser();
  const looked: number[] = [];
  const deps: AgentBrowserDeps = {
    shellPid: async () => { looked.push(100); return 100; },
    discover: async () => ({ status: "live", pid: 101, endpoint: { port: browser.port, browserPath: "/devtools/browser/fake" } }),
    pollMs,
  };
  const clients = new Set<Client>();
  const agentBrowser = createAgentBrowser({ clients, deps, enabled: () => enabled });
  cleanups.push(() => browser.server.stop(true), () => agentBrowser.stop());
  const connect = (readOnly = false, browserOwner = true) => { const client = new FakeClient(readOnly, browserOwner); clients.add(client.socket); return client; };
  return { browser, agentBrowser, connect, clients, looked };
}

it("streams the pane's browser to every watcher and acknowledges each frame to the browser", async () => {
  const { browser, agentBrowser, connect } = harness();
  const first = connect();
  const live = first.next("browser-state", (state) => state.status === "live" && state.target_id === "tab-1");
  const frame = first.next("browser-frame");
  agentBrowser.frames["browser-watch"](first.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  expect((await live).tabs).toEqual([{ id: "tab-1", title: "Shop", url: "https://shop.example.com/cart" }]);
  expect(await frame).toEqual({ type: "browser-frame", pane_id: "p1", target_id: "tab-1", data: "SlBFRw==", width: 1280, height: 720 });
  expect(await browser.told_("Page.screencastFrameAck")).toEqual({ sessionId: 7 });

  const second = connect();
  agentBrowser.frames["browser-watch"](second.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  expect(second.last("browser-frame")?.data).toBe("SlBFRw==");
  expect(browser.open).toBe(1);
});

it("sends input to the page only from the watcher that took control, never from a read-only device", async () => {
  const { browser, agentBrowser, connect } = harness();
  const viewer = connect(true);
  const owner = connect();
  const live = owner.next("browser-frame");
  agentBrowser.frames["browser-watch"](owner.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  agentBrowser.frames["browser-watch"](viewer.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  await live;
  const click = { type: "browser-input", pane_id: "p1", input: { kind: "mouse", action: "down", x: 10, y: 20, button: "left" } } as const;

  agentBrowser.frames["browser-input"](owner.socket, click);
  expect(owner.last("error")?.code).toBe("browser_not_controlled");
  agentBrowser.frames["browser-control"](viewer.socket, { type: "browser-control", pane_id: "p1", take: true });
  expect(viewer.last("error")?.code).toBe("browser_control_refused");

  agentBrowser.frames["browser-control"](owner.socket, { type: "browser-control", pane_id: "p1", take: true });
  expect(owner.last("browser-state")?.control).toBe("you");
  expect(viewer.last("browser-state")?.control).toBe("other");
  agentBrowser.frames["browser-input"](owner.socket, click);
  expect(await browser.told_("Input.dispatchMouseEvent")).toEqual({ type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1, modifiers: 0 });
  expect(browser.told.filter((entry) => entry.method.startsWith("Input."))).toHaveLength(1);
});

it("ends control with the controller's connection, and the browser's connection with the last watcher", async () => {
  const { browser, agentBrowser, connect } = harness();
  const owner = connect();
  const viewer = connect();
  const live = viewer.next("browser-frame");
  agentBrowser.frames["browser-watch"](owner.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  agentBrowser.frames["browser-watch"](viewer.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  await live;
  agentBrowser.frames["browser-control"](owner.socket, { type: "browser-control", pane_id: "p1", take: true });

  agentBrowser.drop(owner.socket);
  expect(viewer.last("browser-state")?.control).toBeNull();
  agentBrowser.frames["browser-watch"](viewer.socket, { type: "browser-watch", pane_id: "p1", enabled: false });
  await until(browser.changed.subscribe, () => (browser.open === 0 ? true : undefined), "the page's DevTools connection to close");
});

it("sends no frame and takes no input on a host the watcher blocked", async () => {
  const { browser, agentBrowser, connect } = harness();
  const careful = connect();
  const live = careful.next("browser-state", (state) => state.status === "live" && state.target_id === "tab-1");
  agentBrowser.frames["browser-watch"](careful.socket, { type: "browser-watch", pane_id: "p1", enabled: true, blocked_hosts: ["example.com"] });
  expect((await live).blocked).toBe(true);
  await browser.told_("Page.screencastFrameAck");
  expect(careful.last("browser-frame")).toBeUndefined();
  agentBrowser.frames["browser-control"](careful.socket, { type: "browser-control", pane_id: "p1", take: true });
  agentBrowser.frames["browser-input"](careful.socket, { type: "browser-input", pane_id: "p1", input: { kind: "text", text: "hunter2" } });
  expect(careful.last("error")?.code).toBe("browser_host_blocked");
  expect(browser.told.some((entry) => entry.method.startsWith("Input."))).toBe(false);
});

it("closes a tab to a watcher that blocked its host from the moment the tab navigates there, not at the next poll", async () => {
  const { browser, agentBrowser, connect } = harness();
  const careful = connect();
  const first = careful.next("browser-frame");
  agentBrowser.frames["browser-watch"](careful.socket, { type: "browser-watch", pane_id: "p1", enabled: true, blocked_hosts: ["bank.example"] });
  await first;
  agentBrowser.frames["browser-control"](careful.socket, { type: "browser-control", pane_id: "p1", take: true });

  const closed = careful.next("browser-state", (state) => state.blocked);
  browser.emit("Page.frameStartedLoading", { frameId: "main" });
  await closed;
  agentBrowser.frames["browser-input"](careful.socket, { type: "browser-input", pane_id: "p1", input: { kind: "text", text: "typed mid-navigation" } });
  expect(careful.last("error")?.code).toBe("browser_host_blocked");
  const named = careful.next("browser-state", (state) => state.tabs[0]?.blocked === true);
  browser.emit("Page.frameNavigated", { frame: { id: "main", url: "https://bank.example./login" } });
  const after = await named;
  expect(after.blocked).toBe(true);
  expect(after.tabs[0]).toEqual({ id: "tab-1", title: "", url: "", blocked: true });
  const frames = careful.frames.filter((frame) => frame.type === "browser-frame").length;
  browser.emit("Page.screencastFrame", { data: "U0VDUkVU", sessionId: 8, metadata: { deviceWidth: 1280, deviceHeight: 720 } });
  await until(browser.changed.subscribe, () => browser.told.find((entry) => entry.method === "Page.screencastFrameAck" && entry.params.sessionId === 8)?.params, "the blocked page's frame to be acknowledged");
  expect(careful.frames.filter((frame) => frame.type === "browser-frame")).toHaveLength(frames);
  expect(browser.told.some((entry) => entry.method.startsWith("Input."))).toBe(false);
});

it("lets only the watcher holding control move the browser to another tab", async () => {
  const { agentBrowser, connect } = harness();
  const owner = connect();
  const viewer = connect();
  const live = owner.next("browser-frame");
  agentBrowser.frames["browser-watch"](owner.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  agentBrowser.frames["browser-watch"](viewer.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  await live;
  agentBrowser.frames["browser-control"](owner.socket, { type: "browser-control", pane_id: "p1", take: true });
  agentBrowser.frames["browser-watch"](viewer.socket, { type: "browser-watch", pane_id: "p1", enabled: true, target_id: "tab-2" });
  expect(viewer.last("error")?.code).toBe("browser_tab_locked");
  expect(owner.last("browser-state")?.control).toBe("you");
});

it("ends control when the connection turns to observing, so typing again needs Take control again", async () => {
  const { browser, agentBrowser, connect } = harness();
  const owner = connect();
  const live = owner.next("browser-frame");
  agentBrowser.frames["browser-watch"](owner.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  await live;
  agentBrowser.frames["browser-control"](owner.socket, { type: "browser-control", pane_id: "p1", take: true });
  agentBrowser.releaseControl(owner.socket);
  expect(owner.last("browser-state")?.control).toBeNull();
  agentBrowser.frames["browser-input"](owner.socket, { type: "browser-input", pane_id: "p1", input: { kind: "text", text: "x" } });
  expect(owner.last("error")?.code).toBe("browser_not_controlled");
  expect(browser.told.some((entry) => entry.method.startsWith("Input."))).toBe(false);
});

it("refuses every browser frame and looks for no browser while the server's setting is off", () => {
  const { agentBrowser, connect, looked } = harness({ enabled: false });
  const owner = connect();
  agentBrowser.frames["browser-watch"](owner.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  expect(owner.last("error")?.code).toBe("browser_disabled");
  agentBrowser.frames["browser-control"](owner.socket, { type: "browser-control", pane_id: "p1", take: true });
  expect(owner.last("error")?.code).toBe("browser_disabled");
  agentBrowser.frames["browser-input"](owner.socket, { type: "browser-input", pane_id: "p1", input: { kind: "text", text: "x" } });
  expect(owner.last("error")?.code).toBe("browser_disabled");
  expect(owner.frames.some((frame) => frame.type === "browser-state" || frame.type === "browser-frame")).toBe(false);
  expect(looked).toEqual([]);
});

it("lets only the owner's own driving connection watch or control a pane's browser", () => {
  const { agentBrowser, connect, looked } = harness();
  // a Portal visitor, an open LAN, or a watching device: not the owner driving
  const visitor = connect(false, false);
  agentBrowser.frames["browser-watch"](visitor.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  expect(visitor.last("error")?.code).toBe("browser_not_owner");
  agentBrowser.frames["browser-control"](visitor.socket, { type: "browser-control", pane_id: "p1", take: true });
  expect(visitor.last("error")?.code).toBe("browser_not_owner");
  expect(visitor.frames.some((frame) => frame.type === "browser-state" || frame.type === "browser-frame")).toBe(false);
  expect(looked).toEqual([]);
});

it("never hands a new watcher a picture taken before the tab's last navigation", async () => {
  const { browser, agentBrowser, connect } = harness();
  browser.tabs = [{ type: "page", id: "tab-1", title: "Bank", url: "https://bank.example/account" }];
  const first = connect();
  const pictured = first.next("browser-frame");
  agentBrowser.frames["browser-watch"](first.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  await pictured;
  const moved = first.next("browser-state", (state) => state.tabs[0]?.url === "https://shop.example.com/");
  browser.emit("Page.frameStartedLoading", { frameId: "main" });
  browser.emit("Page.frameNavigated", { frame: { id: "main", url: "https://shop.example.com/" } });
  await moved;
  const careful = connect();
  agentBrowser.frames["browser-watch"](careful.socket, { type: "browser-watch", pane_id: "p1", enabled: true, blocked_hosts: ["bank.example"] });
  expect(careful.last("browser-state")?.blocked).toBe(false);
  expect(careful.frames.filter((frame) => frame.type === "browser-frame")).toEqual([]);
});

it("ends control when the browser moves to another tab by itself, so clicks never land on a page nobody chose", async () => {
  const { browser, agentBrowser, connect } = harness();
  const owner = connect();
  const live = owner.next("browser-frame");
  agentBrowser.frames["browser-watch"](owner.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  await live;
  agentBrowser.frames["browser-control"](owner.socket, { type: "browser-control", pane_id: "p1", take: true });
  expect(owner.last("browser-state")?.control).toBe("you");
  const switched = owner.next("browser-state", (state) => state.target_id === "tab-2");
  browser.tabs = [{ type: "page", id: "tab-2", title: "Other", url: "https://other.example/" }];
  browser.dropPage();
  expect((await switched).control).toBeNull();
  agentBrowser.frames["browser-input"](owner.socket, { type: "browser-input", pane_id: "p1", input: { kind: "text", text: "x" } });
  expect(owner.last("error")?.code).toBe("browser_not_controlled");
});

it("tells a watcher a tab on a host it blocked only as blocked, and every other address without its query, bounded", async () => {
  const { browser, agentBrowser, connect } = harness();
  const long = "t".repeat(5000);
  browser.listBody = [
    { type: "page", id: "tab-1", title: long, url: `https://shop.example.com/cart?token=secret#${long}` },
    { type: "page", id: "tab-2", title: "My bank", url: "https://www.bank.example/statements?id=7" },
    ...Array.from({ length: 200 }, (_, index) => ({ type: "page", id: `more-${index}`, title: "x", url: "https://shop.example.com/" })),
  ];
  const careful = connect();
  const live = careful.next("browser-state", (state) => state.status === "live");
  agentBrowser.frames["browser-watch"](careful.socket, { type: "browser-watch", pane_id: "p1", enabled: true, blocked_hosts: ["bank.example"] });
  const state = await live;
  expect(state.tabs[0]).toEqual({ id: "tab-1", title: "t".repeat(200), url: "https://shop.example.com/cart" });
  expect(state.tabs[1]).toEqual({ id: "tab-2", title: "", url: "", blocked: true });
  expect(state.tabs.length).toBeLessThanOrEqual(64);
  expect(JSON.stringify(state)).not.toContain("secret");
  expect(JSON.stringify(state)).not.toContain("My bank");
});

it("ends control when the person in control picks another tab, too", async () => {
  const { browser, agentBrowser, connect } = harness();
  browser.tabs = [{ type: "page", id: "tab-1", title: "Shop", url: "https://shop.example.com/" }, { type: "page", id: "tab-2", title: "Other", url: "https://other.example/" }];
  const owner = connect();
  const live = owner.next("browser-frame");
  agentBrowser.frames["browser-watch"](owner.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  await live;
  agentBrowser.frames["browser-control"](owner.socket, { type: "browser-control", pane_id: "p1", take: true });
  const switched = owner.next("browser-state", (state) => state.target_id === "tab-2");
  agentBrowser.frames["browser-watch"](owner.socket, { type: "browser-watch", pane_id: "p1", enabled: true, target_id: "tab-2" });
  expect((await switched).control).toBeNull();
});

it("never serves a picture taken at another address than the one the tab now has, even when only a poll saw it move", async () => {
  const { browser, agentBrowser, connect } = harness({ pollMs: 50 });
  browser.tabs = [{ type: "page", id: "tab-1", title: "Bank", url: "https://bank.example/account" }];
  const first = connect();
  const pictured = first.next("browser-frame");
  agentBrowser.frames["browser-watch"](first.socket, { type: "browser-watch", pane_id: "p1", enabled: true });
  await pictured;
  const moved = first.next("browser-state", (state) => state.tabs[0]?.url === "https://shop.example.com/");
  browser.tabs = [{ type: "page", id: "tab-1", title: "Shop", url: "https://shop.example.com/" }];
  await moved;
  const careful = connect();
  agentBrowser.frames["browser-watch"](careful.socket, { type: "browser-watch", pane_id: "p1", enabled: true, blocked_hosts: ["bank.example"] });
  expect(careful.frames.filter((frame) => frame.type === "browser-frame")).toEqual([]);
});
