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
  tabs = [{ type: "page", id: "tab-1", title: "Shop", url: "https://shop.example.com/cart" }];

  constructor() {
    this.server = Bun.serve<undefined>({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request, server) => {
        const url = new URL(request.url);
        if (url.pathname === "/json/list") return Response.json(this.tabs);
        if (url.pathname.startsWith("/devtools/page/") && server.upgrade(request, { data: undefined })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open: () => { this.open++; this.changed.fire(); },
        close: () => { this.open--; this.changed.fire(); },
        message: (socket, raw) => {
          const message = JSON.parse(String(raw)) as { id: number; method: string; params: Record<string, unknown> };
          this.told.push({ method: message.method, params: message.params });
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
  told_(method: string): Promise<Record<string, unknown>> {
    return until(this.changed.subscribe, () => this.told.find((entry) => entry.method === method)?.params, method);
  }
}

class FakeClient {
  readonly frames: ServerMessage[] = [];
  readonly changed = new Signal();
  readonly socket: Client;
  constructor(readOnly = false) {
    this.socket = {
      data: connectionData({ deviceId: undefined, readOnly }),
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

function harness() {
  const browser = new FakeBrowser();
  const deps: AgentBrowserDeps = {
    shellPid: async () => 100,
    discover: async () => ({ status: "live", pid: 101, endpoint: { port: browser.port, browserPath: "/devtools/browser/fake" } }),
    pollMs: 60_000,
  };
  const clients = new Set<Client>();
  const agentBrowser = createAgentBrowser({ clients, deps });
  cleanups.push(() => browser.server.stop(true), () => agentBrowser.stop());
  const connect = (readOnly = false) => { const client = new FakeClient(readOnly); clients.add(client.socket); return client; };
  return { browser, agentBrowser, connect, clients };
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
