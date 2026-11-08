/**
 * The agent browser panel's frames (feature "agent-browser"): a connection watches a pane's browser
 * (`browser-watch`), and while any does the server finds the browser under the pane's shell
 * (server/agent-browser/discover.ts), streams the chosen tab's screencast to every watcher and tells them its
 * state. It is read-only: input reaches the page only from the one watcher that took control on purpose
 * (`browser-control`), never by default and never from a read-only device or an observer, and control ends
 * with that watcher's watch or connection. Frames and input are never stored or logged.
 */
import type { BrowserInput, BrowserTab, ClientMessage, ServerMessage } from "../../shared/protocol.ts";
import { CdpError, CdpPage, pageTargets } from "../agent-browser/cdp.ts";
import { type BrowserDiscovery, discoverBrowser, discoverDeps } from "../agent-browser/discover.ts";
import { HerdrError, paneProcessInfo } from "../herdr/client.ts";
import { OUTPUT_LOW_BYTES } from "../output-window.ts";
import { backlog, type Client, connectionOf, send } from "./connections.ts";

const POLL_MS = 2000;
const FRAME_INTERVAL_MS = 100;
const SCREENCAST = { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 } as const;
/** a frame past this is skipped rather than sent: the next one replaces it anyway */
const FRAME_MAX_BYTES = 768 * 1024;
const WATCHES_PER_CONNECTION = 4;
const BLOCKED_HOSTS_MAX = 64;
const TEXT_MAX = 4096;

type Frame<K extends ClientMessage["type"]> = Extract<ClientMessage, { type: K }>;

export interface AgentBrowserDeps {
  readonly shellPid: (paneId: string) => Promise<number | null>;
  readonly discover: (shellPid: number) => Promise<BrowserDiscovery>;
  readonly pollMs?: number;
}

interface Session {
  readonly paneId: string;
  /** each watcher's blocked hosts: a tab on one of them sends that watcher no frame and takes no input from it */
  readonly viewers: Map<Client, readonly string[]>;
  controller: Client | null;
  discovery: BrowserDiscovery;
  tabs: BrowserTab[];
  /** the tab a watcher last chose; the first tab when it is gone */
  wanted: string | null;
  targetId: string | null;
  port: number | null;
  page: CdpPage | null;
  frame: { data: string; width: number; height: number } | null;
  lastSent: number;
  frameTimer: ReturnType<typeof setTimeout> | null;
  poll: ReturnType<typeof setInterval>;
  refreshing: boolean;
  ended: boolean;
}

const defaultDeps: AgentBrowserDeps = {
  shellPid: async (paneId) => (await paneProcessInfo(paneId))?.shell_pid ?? null,
  discover: (shellPid) => discoverBrowser(shellPid, discoverDeps),
};

/** Whether `url`'s host is one of `blocked` or under one of them (`example.com` blocks `www.example.com`). */
export function hostBlocked(url: string | undefined, blocked: readonly string[]): boolean {
  if (url === undefined || blocked.length === 0 || !URL.canParse(url)) return false;
  const host = new URL(url).hostname.toLowerCase();
  return blocked.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

function blockedHosts(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > BLOCKED_HOSTS_MAX || !raw.every((entry) => typeof entry === "string" && entry.length <= 253)) return null;
  return raw.map((entry: string) => entry.trim().toLowerCase().replace(/^\*\./, "")).filter((entry) => entry !== "");
}

const finite = (value: unknown, limit: number): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
const modifiers = (value: unknown): number => (Number.isInteger(value) && typeof value === "number" && value >= 0 && value <= 15 ? value : 0);
const MOUSE_TYPES = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;
const BUTTONS = new Set(["none", "left", "middle", "right"]);

/** The CDP command for a checked input, or null when the input is not one the panel sends. */
export function inputCommand(input: BrowserInput): { method: string; params: Record<string, unknown> } | null {
  switch (input.kind) {
    case "mouse": {
      if (!(input.action in MOUSE_TYPES) || !finite(input.x, 100_000) || !finite(input.y, 100_000) || !BUTTONS.has(input.button)) return null;
      const clicks = Number.isInteger(input.clicks) && (input.clicks ?? 0) >= 0 && (input.clicks ?? 0) <= 3 ? input.clicks : input.action === "move" ? 0 : 1;
      return { method: "Input.dispatchMouseEvent", params: { type: MOUSE_TYPES[input.action], x: input.x, y: input.y, button: input.button, clickCount: clicks, modifiers: modifiers(input.modifiers) } };
    }
    case "wheel":
      if (!finite(input.x, 100_000) || !finite(input.y, 100_000) || !finite(input.dx, 100_000) || !finite(input.dy, 100_000)) return null;
      return { method: "Input.dispatchMouseEvent", params: { type: "mouseWheel", x: input.x, y: input.y, deltaX: input.dx, deltaY: input.dy, modifiers: modifiers(input.modifiers) } };
    case "key": {
      if ((input.action !== "down" && input.action !== "up") || typeof input.key !== "string" || input.key.length > 32 || typeof input.code !== "string" || input.code.length > 32) return null;
      const text = typeof input.text === "string" && input.text.length <= 4 && input.action === "down" ? input.text : undefined;
      const keyCode = Number.isInteger(input.key_code) && (input.key_code ?? -1) >= 0 && (input.key_code ?? 0) <= 255 ? input.key_code : undefined;
      return { method: "Input.dispatchKeyEvent", params: { type: input.action === "up" ? "keyUp" : text === undefined ? "rawKeyDown" : "keyDown", key: input.key, code: input.code, modifiers: modifiers(input.modifiers),
        ...(text === undefined ? {} : { text, unmodifiedText: text }), ...(keyCode === undefined ? {} : { windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }) } };
    }
    case "text":
      if (typeof input.text !== "string" || input.text.length === 0 || input.text.length > TEXT_MAX) return null;
      return { method: "Input.insertText", params: { text: input.text } };
    default:
      return null;
  }
}

/** The errors a look at the browser may meet while it starts, closes or never was: the panel then shows none. */
function lookFailed(error: unknown): boolean {
  return error instanceof HerdrError || error instanceof CdpError || error instanceof TypeError || error instanceof SyntaxError || error instanceof DOMException;
}

export function createAgentBrowser({ clients, deps = defaultDeps }: { clients: Set<Client>; deps?: AgentBrowserDeps }) {
  const sessions = new Map<string, Session>();
  const open = (client: Client): boolean => clients.has(client) && !connectionOf(client).closing && client.readyState === WebSocket.OPEN;

  function currentUrl(session: Session): string | undefined {
    return session.tabs.find((tab) => tab.id === session.targetId)?.url;
  }

  function stateFor(session: Session, client: Client): ServerMessage {
    const blocked = hostBlocked(currentUrl(session), session.viewers.get(client) ?? []);
    return {
      type: "browser-state", pane_id: session.paneId, status: session.discovery.status, tabs: session.tabs, target_id: session.targetId,
      control: session.controller === null ? null : session.controller === client ? "you" : "other", blocked,
    };
  }

  function broadcastState(session: Session): void {
    for (const client of session.viewers.keys()) if (open(client)) send(client, stateFor(session, client));
  }

  function sendFrame(session: Session, client: Client): void {
    const frame = session.frame;
    if (frame === null || session.targetId === null || !open(client) || hostBlocked(currentUrl(session), session.viewers.get(client) ?? [])) return;
    // a frame is only worth sending to a socket that keeps up: one behind skips it, and its terminal output goes first
    if (backlog(client) > OUTPUT_LOW_BYTES) return;
    send(client, { type: "browser-frame", pane_id: session.paneId, target_id: session.targetId, data: frame.data, width: frame.width, height: frame.height });
  }

  function flushFrame(session: Session): void {
    session.frameTimer = null;
    session.lastSent = Date.now();
    for (const client of session.viewers.keys()) sendFrame(session, client);
  }

  function frameArrived(session: Session): void {
    if (session.frameTimer !== null) return;
    const wait = session.lastSent + FRAME_INTERVAL_MS - Date.now();
    if (wait <= 0) flushFrame(session);
    else session.frameTimer = setTimeout(() => flushFrame(session), wait);
  }

  function closePage(session: Session): void {
    const page = session.page;
    session.page = null;
    session.frame = null;
    if (session.frameTimer !== null) { clearTimeout(session.frameTimer); session.frameTimer = null; }
    page?.close();
  }

  async function openPage(session: Session, port: number, targetId: string): Promise<void> {
    const page = await CdpPage.open(port, targetId, () => {
      if (session.page !== page) return;
      session.page = null;
      session.targetId = null;
      void refresh(session);
    });
    if (session.ended || session.port !== port || session.targetId !== targetId) { page.close(); return; }
    session.page = page;
    page.on("Page.screencastFrame", (params) => {
      if (session.page !== page) return;
      void page.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch((error: unknown) => { if (!(error instanceof CdpError)) throw error; });
      const metadata = typeof params.metadata === "object" && params.metadata !== null ? params.metadata as Record<string, unknown> : {};
      const width = Number(metadata.deviceWidth);
      const height = Number(metadata.deviceHeight);
      if (typeof params.data !== "string" || params.data.length > FRAME_MAX_BYTES || !(width > 0) || !(height > 0)) return;
      session.frame = { data: params.data, width, height };
      frameArrived(session);
    });
    await page.send("Page.startScreencast", { ...SCREENCAST });
  }

  async function look(session: Session): Promise<void> {
    const shell = await deps.shellPid(session.paneId);
    const discovery: BrowserDiscovery = shell === null ? { status: "none" } : await deps.discover(shell);
    const port = discovery.status === "live" ? discovery.endpoint.port : null;
    const tabs = port === null ? [] : await pageTargets(port);
    if (session.ended) return;
    const target = tabs.find((tab) => tab.id === session.wanted) ?? tabs.find((tab) => tab.id === session.targetId) ?? tabs[0] ?? null;
    const moved = port !== session.port || target?.id !== session.targetId || (target !== null && session.page === null);
    session.discovery = discovery;
    session.tabs = tabs;
    if (port === null && session.controller !== null) session.controller = null;
    if (moved) {
      closePage(session);
      session.port = port;
      session.targetId = target?.id ?? null;
      if (port !== null && target !== null) {
        broadcastState(session);
        await openPage(session, port, target.id);
      }
    }
    broadcastState(session);
  }

  async function refresh(session: Session): Promise<void> {
    if (session.refreshing || session.ended) return;
    session.refreshing = true;
    try {
      await look(session);
    } catch (error) {
      if (!lookFailed(error)) throw error;
      if (session.ended) return;
      closePage(session);
      session.discovery = { status: "none" };
      session.tabs = [];
      session.port = null;
      session.targetId = null;
      session.controller = null;
      broadcastState(session);
    } finally {
      session.refreshing = false;
    }
  }

  function end(session: Session): void {
    session.ended = true;
    clearInterval(session.poll);
    closePage(session);
    sessions.delete(session.paneId);
  }

  function release(client: Client, paneId: string): void {
    const session = sessions.get(paneId);
    if (!session || !session.viewers.delete(client)) return;
    if (session.viewers.size === 0) { end(session); return; }
    if (session.controller === client) { session.controller = null; broadcastState(session); }
  }

  function watchesOf(client: Client): number {
    let count = 0;
    for (const session of sessions.values()) if (session.viewers.has(client)) count++;
    return count;
  }

  function refused(client: Client, code: string, message: string, paneId?: string): void {
    send(client, { type: "error", code, message, ...(paneId === undefined ? {} : { pane_id: paneId }) });
  }

  const validPane = (paneId: unknown): paneId is string => typeof paneId === "string" && paneId.trim() !== "" && paneId.length <= 256;

  return {
    frames: {
      "browser-watch"(client: Client, message: Frame<"browser-watch">): void {
        const blocked = blockedHosts(message.blocked_hosts);
        if (!validPane(message.pane_id) || typeof message.enabled !== "boolean" || blocked === null || (message.target_id !== undefined && typeof message.target_id !== "string")) {
          refused(client, "invalid_browser_watch", "pane_id must be a nonempty string, enabled a boolean and blocked_hosts at most 64 host names");
          return;
        }
        if (!message.enabled) { release(client, message.pane_id); return; }
        let session = sessions.get(message.pane_id);
        if (!session?.viewers.has(client) && watchesOf(client) >= WATCHES_PER_CONNECTION) {
          refused(client, "too_many_browser_watches", `at most ${WATCHES_PER_CONNECTION} browser watches per connection`, message.pane_id);
          return;
        }
        if (!session) {
          const created: Session = {
            paneId: message.pane_id, viewers: new Map(), controller: null, discovery: { status: "none" }, tabs: [], wanted: null, targetId: null, port: null,
            page: null, frame: null, lastSent: 0, frameTimer: null, refreshing: false, ended: false,
            poll: setInterval(() => { void refresh(created); }, deps.pollMs ?? POLL_MS),
          };
          created.poll.unref?.();
          sessions.set(message.pane_id, created);
          session = created;
        }
        const joined = !session.viewers.has(client);
        session.viewers.set(client, blocked);
        const tabChosen = message.target_id !== undefined && message.target_id !== session.targetId;
        if (message.target_id !== undefined) session.wanted = message.target_id;
        if (tabChosen) { void refresh(session); return; }
        send(client, stateFor(session, client));
        if (joined) {
          sendFrame(session, client);
          if (session.page === null) void refresh(session);
        }
      },
      "browser-control"(client: Client, message: Frame<"browser-control">): void {
        if (!validPane(message.pane_id) || typeof message.take !== "boolean") {
          refused(client, "invalid_browser_control", "pane_id must be a nonempty string and take a boolean");
          return;
        }
        const session = sessions.get(message.pane_id);
        if (!session?.viewers.has(client)) { refused(client, "browser_not_watched", "watch the pane's browser first", message.pane_id); return; }
        if (!message.take) {
          if (session.controller === client) { session.controller = null; broadcastState(session); }
          return;
        }
        if (client.data.readOnly || connectionOf(client).mode !== "interact") { refused(client, "browser_control_refused", "this device only views", message.pane_id); return; }
        if (session.page === null) { refused(client, "browser_unavailable", "no browser to control", message.pane_id); return; }
        session.controller = client;
        broadcastState(session);
      },
      "browser-input"(client: Client, message: Frame<"browser-input">): void {
        const session = validPane(message.pane_id) ? sessions.get(message.pane_id) : undefined;
        if (!session || session.controller !== client || session.page === null) {
          refused(client, "browser_not_controlled", "take control of the browser first", validPane(message.pane_id) ? message.pane_id : undefined);
          return;
        }
        if (client.data.readOnly || connectionOf(client).mode !== "interact") { refused(client, "browser_control_refused", "this device only views", message.pane_id); return; }
        if (hostBlocked(currentUrl(session), session.viewers.get(client) ?? [])) { refused(client, "browser_host_blocked", "this page's host is blocked here", message.pane_id); return; }
        const command = typeof message.input === "object" && message.input !== null ? inputCommand(message.input) : null;
        if (command === null) { refused(client, "invalid_browser_input", "the input is not one the panel sends", message.pane_id); return; }
        void session.page.send(command.method, command.params).catch((error: unknown) => {
          if (!(error instanceof CdpError)) throw error;
          if (open(client)) refused(client, "browser_input_failed", "the browser did not take the input", message.pane_id);
        });
      },
    },
    drop(client: Client): void {
      for (const paneId of [...sessions.keys()]) release(client, paneId);
    },
    stop(): void {
      for (const session of [...sessions.values()]) end(session);
    },
  };
}
