/**
 * Messages the user scheduled for a pane's agent (#2919): kept by this PC, in its state folder, so each goes out
 * at its time with every device closed. At its time a message is typed as a queued next-turn message is
 * (server/core/pending.ts sendScheduled): it waits for the agent's turn, never goes over a draft or an open
 * question, and only into the terminal and agent session it was scheduled for. One whose pane is gone or runs
 * another session is held with the reason until the user sends or discards it. A message is claimed (`sending`)
 * before anything is typed, so the timer and a Send now never send it twice; one the PC stopped in the middle of
 * is never sent again on its own.
 *
 * Routes (finite paths, so a connection server can pass them to a remote PC: server/machine-api.ts):
 *   GET  /api/scheduled                 { messages }
 *   POST /api/scheduled                 { pane_id, text, send_at } -> { message }
 *   POST /api/scheduled/update          { id, text?, send_at? }    -> { message }
 *   POST /api/scheduled/discard         { id }                     -> { ok }
 *   POST /api/scheduled/send            { id }                     -> { ok }, or the refusal
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScheduledMessage } from "../shared/protocol.ts";
import { HerdrError } from "./herdr/client.ts";
import { jsonResponse, setRequestRoute } from "./http.ts";
import type { PendingIdentity } from "./pending-input.ts";
import { pendingText } from "./core/composer.ts";

type Reply = { ok: boolean; code?: string; message?: string };

/** refusals that only mean "not yet": the message stays scheduled, says why, and is tried again at the pane's next event */
const WAIT_CODES = new Set(["pending_wait", "agent_blocked", "agent_not_ready", "input_not_ready", "input_draft", "rewind_dialog_open", "submit_timeout"]);
/** a delivery that may have typed part of the message: never sent again on its own or by Send now */
const UNCERTAIN_CODES = new Set(["submit_changed", "pasted_not_sent"]);
export const MAX_SCHEDULED = 64;
const MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** a due message waiting for its turn is also tried this often, as a missed pane event must not strand it */
const RETRY_MS = 30_000;
/** the longest setTimeout delay */
const MAX_TIMER_MS = 2_147_483_647;
const FILE = "scheduled-messages.json";

interface Entry { message: ScheduledMessage; identity: PendingIdentity; device: string | null; triedAt?: number }

export class ScheduledError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export interface ScheduledDeps {
  /** where the messages are kept; none keeps them in memory only */
  stateDir?: string;
  /** what runs in the pane now (pane_not_found when it is gone) */
  identity: (paneId: string) => Promise<PendingIdentity>;
  send: (paneId: string, text: string, identity: PendingIdentity, automatic: boolean, authorize: () => void) => Promise<Reply>;
  /** whether the device that scheduled a message may still drive this PC (null: no paired device, as the token or this PC) */
  mayDrive: (device: string | null) => boolean;
  /** the list changed: every connection reads it again */
  changed: () => void;
  now?: () => number;
  retryMs?: number;
}

export class ScheduledMessages {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly now: () => number;

  constructor(private readonly deps: ScheduledDeps) {
    this.now = deps.now ?? Date.now;
    for (const entry of this.load()) this.entries.set(entry.message.id, entry);
  }

  list(): ScheduledMessage[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.message, ...(entry.message.error ? { error: { ...entry.message.error } } : {}) }))
      .sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at));
  }

  async create(body: unknown, device: string | null): Promise<ScheduledMessage> {
    const record = object(body);
    const paneId = typeof record["pane_id"] === "string" && record["pane_id"] ? record["pane_id"] : null;
    if (paneId === null) throw new ScheduledError("missing_pane_id", "pane_id is required");
    const text = this.text(record["text"]);
    const sendAt = this.sendAt(record["send_at"]);
    if (this.entries.size >= MAX_SCHEDULED) throw new ScheduledError("scheduled_limit", `At most ${MAX_SCHEDULED} messages can be scheduled; send or discard one first`, 409);
    let identity: PendingIdentity;
    try { identity = await this.deps.identity(paneId); } catch (error) {
      if (error instanceof HerdrError && error.code === "pane_not_found") throw new ScheduledError("pane_not_found", "The pane is gone", 404);
      throw error;
    }
    const message: ScheduledMessage = { id: crypto.randomUUID(), pane_id: paneId, text, send_at: sendAt, created_at: new Date(this.now()).toISOString(), state: "scheduled" };
    this.entries.set(message.id, { message, identity, device });
    this.commit();
    return { ...message };
  }

  /** A new text or time; a held message is scheduled again for it, still for the session it was scheduled for. */
  update(body: unknown): ScheduledMessage {
    const record = object(body);
    const entry = this.entry(record["id"]);
    if (entry.message.state === "sending") throw busy();
    if (entry.message.state === "uncertain") throw uncertain();
    if (record["text"] !== undefined) entry.message.text = this.text(record["text"]);
    if (record["send_at"] !== undefined) entry.message.send_at = this.sendAt(record["send_at"]);
    entry.message.state = "scheduled";
    delete entry.message.error;
    delete entry.triedAt;
    this.commit();
    return { ...entry.message };
  }

  discard(body: unknown): void {
    const entry = this.entry(object(body)["id"]);
    if (entry.message.state === "sending") throw busy();
    this.entries.delete(entry.message.id);
    this.commit();
  }

  /**
   * The user's Send now: to what runs in the pane now (the user saw why it was held), steering a working agent as a
   * pending message's Send now does. A refusal leaves the message as it was, with the reason.
   */
  async sendNow(body: unknown, device: string | null): Promise<Reply> {
    const entry = this.entry(object(body)["id"]);
    if (entry.message.state === "sending") throw busy();
    if (entry.message.state === "uncertain") throw uncertain();
    const before = entry.message.state;
    let identity: PendingIdentity;
    try { identity = await this.deps.identity(entry.message.pane_id); } catch (error) {
      const fault = faultOf(error);
      return { ok: false, ...fault };
    }
    if (this.entries.get(entry.message.id) !== entry || entry.message.state !== before) throw busy();
    entry.identity = identity;
    entry.device = device;
    return await this.deliver(entry, false);
  }

  /** an event of the pane (a turn ended, input became ready): its due messages are tried again */
  paneEvent(paneId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.message.pane_id === paneId && this.due(entry)) void this.deliver(entry, true);
    }
  }

  /** herdr moved the pane under a new ID: its messages follow it */
  paneMoved(from: string, to: string): void {
    let moved = false;
    for (const entry of this.entries.values()) if (entry.message.pane_id === from) { entry.message.pane_id = to; moved = true; }
    if (moved) this.commit();
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private due(entry: Entry): boolean {
    return !this.stopped && entry.message.state === "scheduled" && Date.parse(entry.message.send_at) <= this.now();
  }

  private async deliver(entry: Entry, automatic: boolean): Promise<Reply> {
    const message = entry.message;
    const before = { state: message.state, error: message.error };
    message.state = "sending";
    entry.triedAt = this.now();
    // claimed and kept before anything is typed: a PC that stops now never sends it again on its own
    this.save();
    const authorize = (): void => {
      if (this.stopped) throw new HerdrError("cancelled", "This PC's server is stopping");
      if (!this.deps.mayDrive(entry.device)) throw new HerdrError("device_revoked", "The device that scheduled this message can no longer drive this PC");
    };
    let reply: Reply;
    try {
      authorize();
      reply = await this.deps.send(message.pane_id, message.text, entry.identity, automatic, authorize);
    } catch (error) {
      reply = { ok: false, ...faultOf(error) };
    }
    if (reply.ok) {
      this.entries.delete(message.id);
    } else {
      const fault = { code: reply.code ?? "submit_failed", message: reply.message ?? "The message was not sent" };
      if (UNCERTAIN_CODES.has(fault.code)) message.state = "uncertain";
      // Send now's refusal leaves it as it was; the timer's waits stay scheduled and say why
      else if (!automatic) message.state = before.state;
      else message.state = WAIT_CODES.has(fault.code) ? "scheduled" : "held";
      message.error = fault;
    }
    this.commit(automatic && !reply.ok && message.state === "scheduled" && sameFault(before.error, message.error));
    return reply;
  }

  /** saves, tells every connection (unless nothing they see changed), and sets the timer for the next due message */
  private commit(quiet = false): void {
    this.save();
    if (!quiet) this.deps.changed();
    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped) return;
    const retry = this.deps.retryMs ?? RETRY_MS;
    let next = Infinity;
    for (const entry of this.entries.values()) {
      if (entry.message.state !== "scheduled") continue;
      const at = Date.parse(entry.message.send_at);
      next = Math.min(next, entry.triedAt !== undefined && at <= entry.triedAt ? entry.triedAt + retry : at);
    }
    if (next === Infinity) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      for (const entry of this.entries.values()) if (this.due(entry) && (entry.triedAt === undefined || entry.triedAt + retry <= this.now())) void this.deliver(entry, true);
      this.arm();
    }, Math.min(MAX_TIMER_MS, Math.max(0, next - this.now())));
    this.timer.unref?.();
  }

  private entry(id: unknown): Entry {
    const entry = typeof id === "string" ? this.entries.get(id) : undefined;
    if (!entry) throw new ScheduledError("scheduled_not_found", "This scheduled message was sent or discarded", 404);
    return entry;
  }

  private text(value: unknown): string {
    if (typeof value !== "string") throw new ScheduledError("invalid_submit_text", "text is required");
    try { return pendingText(value); } catch (error) { throw new ScheduledError("invalid_submit_text", error instanceof Error ? error.message : String(error)); }
  }

  private sendAt(value: unknown): string {
    const at = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(at)) throw new ScheduledError("invalid_send_at", "send_at must be a date and time");
    if (at > this.now() + MAX_AHEAD_MS) throw new ScheduledError("invalid_send_at", "A message can be scheduled at most 30 days ahead");
    return new Date(at).toISOString();
  }

  private get path(): string | null {
    return this.deps.stateDir === undefined ? null : join(this.deps.stateDir, FILE);
  }

  private load(): Entry[] {
    const path = this.path;
    if (path === null) return [];
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { return []; }
    if (!Array.isArray(raw)) return [];
    const entries: Entry[] = [];
    for (const item of raw as Entry[]) {
      const message = item?.message;
      if (!message || typeof message.id !== "string" || typeof message.pane_id !== "string" || typeof message.text !== "string"
        || !Number.isFinite(Date.parse(message.send_at)) || !item.identity || typeof item.identity.terminalId !== "string") continue;
      // stopped in the middle of its send: it may have been typed, so it is the user's to check
      if (message.state === "sending") {
        message.state = "uncertain";
        message.error = { code: "submit_changed", message: "This PC's server stopped while sending this message. Check the terminal before sending it again." };
      }
      if (!["scheduled", "held", "uncertain"].includes(message.state)) continue;
      entries.push({ message, identity: item.identity, device: typeof item.device === "string" ? item.device : null });
    }
    return entries;
  }

  private save(): void {
    const path = this.path;
    if (path === null) return;
    mkdirSync(this.deps.stateDir!, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify([...this.entries.values()].map(({ message, identity, device }) => ({ message, identity, device }))), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  }
}

const busy = (): ScheduledError => new ScheduledError("pending_busy", "This message is being sent", 409);
const uncertain = (): ScheduledError => new ScheduledError("pending_uncertain", "Check the terminal before sending this message again", 409);
const sameFault = (a: { code: string; message: string } | undefined, b: { code: string; message: string } | undefined): boolean =>
  a?.code === b?.code && a?.message === b?.message;
const faultOf = (error: unknown): { code: string; message: string } => ({
  code: error instanceof HerdrError ? error.code : "submit_failed",
  message: error instanceof Error ? error.message : String(error),
});
const object = (body: unknown): Record<string, unknown> => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new ScheduledError("invalid_body", "A JSON object is required");
  return body as Record<string, unknown>;
};

/** The routes above; `readOnly`: a watching device, which neither reads nor changes them. */
export async function handleScheduledRequest(request: Request, pathname: string, scheduled: ScheduledMessages, access: { readOnly: boolean; device: string | null }): Promise<Response | null> {
  const action = pathname === "/api/scheduled" ? "" : pathname.startsWith("/api/scheduled/") ? pathname.slice("/api/scheduled/".length) : null;
  if (action === null || !["", "update", "discard", "send"].includes(action)) return null;
  setRequestRoute(pathname);
  if (access.readOnly) return jsonResponse({ error: { code: "read_only", message: "this device can only watch" } }, 403);
  if (action === "" && request.method === "GET") return jsonResponse({ messages: scheduled.list() }, 200, { "cache-control": "no-store" });
  if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: action === "" ? "Use GET or POST" : "Use POST" } }, 405);
  let body: unknown;
  try { body = await request.json(); } catch { return jsonResponse({ error: { code: "invalid_body", message: "A JSON object is required" } }, 400); }
  try {
    if (action === "") return jsonResponse({ message: await scheduled.create(body, access.device) }, 201);
    if (action === "update") return jsonResponse({ message: scheduled.update(body) });
    if (action === "discard") { scheduled.discard(body); return jsonResponse({ ok: true }); }
    const reply = await scheduled.sendNow(body, access.device);
    return reply.ok ? jsonResponse({ ok: true }) : jsonResponse({ error: { code: reply.code, message: reply.message } }, 409);
  } catch (error) {
    if (error instanceof ScheduledError) return jsonResponse({ error: { code: error.code, message: error.message } }, error.status);
    throw error;
  }
}
