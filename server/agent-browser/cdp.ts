/**
 * The least of the Chrome DevTools Protocol the agent browser panel needs: one WebSocket to one page target, its
 * commands answered by id and its events by method. Loopback only: the caller builds the URL from a proved port.
 */
export class CdpError extends Error {
  constructor(readonly code: "cdp_closed" | "cdp_refused" | "cdp_timeout", message: string) {
    super(message);
  }
}

type Listener = (params: Record<string, unknown>) => void;

const COMMAND_TIMEOUT_MS = 5000;

export class CdpPage {
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve: (result: unknown) => void; reject: (error: CdpError) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Map<string, Listener>();
  private closed = false;

  private constructor(private readonly socket: WebSocket, onClose: () => void) {
    socket.addEventListener("message", (event) => this.receive(String(event.data)));
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const { reject, timer } of this.waiting.values()) { clearTimeout(timer); reject(new CdpError("cdp_closed", "the page's DevTools connection closed")); }
      this.waiting.clear();
      onClose();
    });
  }

  /** Opens `ws://127.0.0.1:<port>/devtools/page/<id>`; rejects when it does not open. */
  static open(port: number, targetId: string, onClose: () => void): Promise<CdpPage> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${encodeURIComponent(targetId)}`);
    return new Promise((resolve, reject) => {
      // a listener that never answers would hold the session's look forever
      const timer = setTimeout(() => { socket.close(); reject(new CdpError("cdp_timeout", "the page's DevTools connection did not open")); }, COMMAND_TIMEOUT_MS);
      const failed = () => { clearTimeout(timer); reject(new CdpError("cdp_closed", "the page's DevTools connection did not open")); };
      socket.addEventListener("error", failed, { once: true });
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        socket.removeEventListener("error", failed);
        resolve(new CdpPage(socket, onClose));
      }, { once: true });
    });
  }

  on(method: string, listener: Listener): void {
    this.listeners.set(method, listener);
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new CdpError("cdp_closed", "the page's DevTools connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new CdpError("cdp_timeout", `${method} was not answered`));
      }, COMMAND_TIMEOUT_MS);
      this.waiting.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    if (!this.closed) this.socket.close();
  }

  private receive(text: string): void {
    let message: unknown;
    try { message = JSON.parse(text); } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    if (typeof record.id === "number") {
      const waiter = this.waiting.get(record.id);
      if (!waiter) return;
      this.waiting.delete(record.id);
      clearTimeout(waiter.timer);
      if (record.error !== undefined) waiter.reject(new CdpError("cdp_refused", "the browser refused a command"));
      else waiter.resolve(record.result);
      return;
    }
    if (typeof record.method === "string") {
      const params = typeof record.params === "object" && record.params !== null ? record.params as Record<string, unknown> : {};
      this.listeners.get(record.method)?.(params);
    }
  }
}

export interface PageTarget {
  readonly id: string;
  readonly title: string;
  readonly url: string;
}

/** The browser's page targets (`/json/list`), DevTools' own pages left out. */
export async function pageTargets(port: number): Promise<PageTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new CdpError("cdp_refused", "the browser did not list its pages");
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new CdpError("cdp_refused", "the browser did not list its pages");
  return body.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { type, id, title, url } = entry as Record<string, unknown>;
    if (type !== "page" || typeof id !== "string" || typeof url !== "string" || url.startsWith("devtools://")) return [];
    return [{ id, title: typeof title === "string" ? title : "", url }];
  });
}
