import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HerdrError } from "./herdr/client.ts";
import type { PendingIdentity } from "./pending-input.ts";
import { handleScheduledRequest, ScheduledError, ScheduledMessages, type ScheduledDeps } from "./scheduled-messages.ts";

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** the core's pendingText as far as these tests lean on it: trailing line breaks go, and blank text is refused */
const pendingText = (text: string): string => {
  const trimmed = text.replace(/[\r\n]+$/, "");
  if (!trimmed.trim()) throw new Error("A pending chat message must be nonempty text");
  return trimmed;
};
const IDENTITY: PendingIdentity = { agent: "claude", terminalId: "t1", session: "claude:herdr:s1", processPid: 7, processBirth: 1 };
type Send = Parameters<ScheduledDeps["send"]>;

/** A store over a fresh state folder whose sends answer `answers` in turn (ok once they run out). */
function store(answers: Array<{ ok: boolean; code?: string; message?: string } | Error> = [], over: Partial<ScheduledDeps> = {}) {
  const stateDir = over.stateDir ?? mkdtempSync(join(tmpdir(), "ovis-scheduled-"));
  if (!over.stateDir) dirs.push(stateDir);
  const sends: Send[] = [];
  let changes = 0;
  const waiters: Array<() => void> = [];
  const clock = { now: Date.parse("2026-11-05T10:00:00Z") };
  const scheduled = new ScheduledMessages({
    stateDir, checkText: pendingText, identity: async () => ({ ...IDENTITY }), mayDrive: () => true, changed: () => { changes++; }, now: () => clock.now,
    send: async (...args) => {
      sends.push(args);
      args[4]();
      waiters.shift()?.();
      const answer = answers.shift() ?? { ok: true };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    ...over,
  });
  stops.push(() => scheduled.stop());
  const sent = () => new Promise<void>((resolve) => { waiters.push(resolve); });
  return { scheduled, sends, stateDir, clock, sent, changes: () => changes };
}

/** every fake here answers in microtasks: a macrotask turn sees each delivery settled */
const settle = () => new Promise<void>((resolve) => { setImmediate(resolve); });

it("keeps a scheduled message in the state folder, readable only by this user, and lists it after a restart", async () => {
  const { scheduled, stateDir } = store();
  const message = await scheduled.create({ pane_id: "p1", text: "continue\r\n", send_at: "2026-11-05T15:00:00+09:00" }, "dev1");
  expect(message).toMatchObject({ pane_id: "p1", text: "continue", send_at: "2026-11-05T06:00:00.000Z", state: "scheduled" });
  const file = join(stateDir, "scheduled-messages.json");
  if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  const again = new ScheduledMessages({ stateDir, checkText: pendingText, identity: async () => IDENTITY, send: async () => ({ ok: true }), mayDrive: () => true, changed: () => {} });
  expect(again.list()).toEqual([message]);
});

it("sends a due message to the identity it was scheduled for, then removes it", async () => {
  const { scheduled, sends, clock } = store();
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T10:00:00Z" }, null);
  clock.now += 1;
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(sends.map(([pane, text, identity, automatic]) => [pane, text, identity, automatic])).toEqual([["p1", "continue", IDENTITY, true]]);
  expect(scheduled.list()).toEqual([]);
});

it("sends a message at its time from the timer alone, with no pane event", async () => {
  const { scheduled, sends, sent, clock } = store();
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: new Date(clock.now + 20).toISOString() }, null);
  clock.now += 20;
  const delivered = sent();
  scheduled.start();
  await delivered;
  expect(sends).toHaveLength(1);
});

it("waits while the agent works, saying why, and goes at the pane's next event", async () => {
  const { scheduled, sends } = store([{ ok: false, code: "pending_wait", message: "The agent is working again" }]);
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]).toMatchObject({ state: "scheduled", error: { code: "pending_wait" } });
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toHaveLength(2);
  expect(scheduled.list()).toEqual([]);
});

it("never types over a draft: input_draft keeps it waiting", async () => {
  const { scheduled } = store([{ ok: false, code: "input_draft", message: "Claude Code's input box is not empty" }]);
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]).toMatchObject({ state: "scheduled", error: { code: "input_draft" } });
});

it("holds a message whose pane now runs another session, until the user sends or discards it", async () => {
  const { scheduled, sends } = store([{ ok: false, code: "pending_target_changed", message: "changed" }]);
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]).toMatchObject({ state: "held", error: { code: "pending_target_changed" } });
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toHaveLength(1);
  expect(await scheduled.sendNow({ id: message.id }, null)).toEqual({ ok: true });
  expect(sends[1]![3]).toBe(false);
  expect(scheduled.list()).toEqual([]);
});

it("holds a message for a pane that is gone", async () => {
  const { scheduled } = store([new HerdrError("pane_not_found", "pane p1 not found")]);
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(scheduled.list()[0]).toMatchObject({ state: "held", error: { code: "pane_not_found" } });
});

it("claims a message before typing: a Send now during its send is refused and it goes once", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sends: Send[] = [];
  const { scheduled } = store([], { send: async (...args) => { sends.push(args); await gate; return { ok: true }; } });
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  scheduled.paneEvent("p1");
  expect(scheduled.list()[0]!.state).toBe("sending");
  await expect(scheduled.sendNow({ id: message.id }, null)).rejects.toMatchObject({ code: "pending_busy" });
  expect(() => scheduled.discard({ id: message.id })).toThrow(ScheduledError);
  release();
  await settle();
  expect(sends).toHaveLength(1);
});

it("never sends again on its own a message the PC stopped in the middle of", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-scheduled-"));
  dirs.push(stateDir);
  writeFileSync(join(stateDir, "scheduled-messages.json"), JSON.stringify([{ identity: IDENTITY, device: null,
    message: { id: "a", pane_id: "p1", text: "continue", send_at: "2026-11-05T09:00:00Z", created_at: "2026-11-05T08:00:00Z", state: "sending" } }]));
  const { scheduled, sends } = store([], { stateDir });
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toEqual([]);
  expect(scheduled.list()[0]).toMatchObject({ state: "uncertain", error: { code: "submit_changed" } });
  await expect(scheduled.sendNow({ id: "a" }, null)).rejects.toMatchObject({ code: "pending_uncertain" });
});

it("does not send for a device that may no longer drive this PC", async () => {
  let drives = true;
  const { scheduled, sends } = store([], { mayDrive: () => drives });
  await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, "dev1");
  drives = false;
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  expect(sends).toEqual([]);
  expect(scheduled.list()[0]).toMatchObject({ state: "held", error: { code: "device_revoked" } });
});

it("edits a held message back to scheduled, and follows its pane when herdr moves it", async () => {
  const { scheduled } = store([{ ok: false, code: "pending_target_changed", message: "changed" }]);
  const message = await scheduled.create({ pane_id: "p1", text: "continue", send_at: "2026-11-05T09:59:00Z" }, null);
  scheduled.start();
  scheduled.paneEvent("p1");
  await settle();
  scheduled.stop();
  expect(scheduled.update({ id: message.id, text: "go on", send_at: "2026-11-05T12:00:00Z" })).toMatchObject({ text: "go on", state: "scheduled", send_at: "2026-11-05T12:00:00.000Z" });
  expect(scheduled.list()[0]!.error).toBeUndefined();
  scheduled.paneMoved("p1", "p9");
  expect(scheduled.list()[0]!.pane_id).toBe("p9");
});

it("refuses a time more than 30 days ahead, an empty text and a pane that is gone", async () => {
  const { scheduled } = store([], { identity: async () => { throw new HerdrError("pane_not_found", "gone"); } });
  await expect(scheduled.create({ pane_id: "p1", text: "x", send_at: "2026-12-06T10:00:00Z" }, null)).rejects.toMatchObject({ code: "invalid_send_at" });
  await expect(scheduled.create({ pane_id: "p1", text: " \n", send_at: "2026-11-05T11:00:00Z" }, null)).rejects.toMatchObject({ code: "invalid_submit_text" });
  await expect(scheduled.create({ pane_id: "p1", text: "x", send_at: "2026-11-05T11:00:00Z" }, null)).rejects.toMatchObject({ code: "pane_not_found", status: 404 });
});

it("answers a watching device read_only, and lists and creates for one that drives", async () => {
  const { scheduled } = store();
  const post = (path: string, body: unknown) => new Request(`http://pc${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const watch = await handleScheduledRequest(new Request("http://pc/api/scheduled"), "/api/scheduled", scheduled, { readOnly: true, device: "w" });
  expect(watch?.status).toBe(403);
  const created = await handleScheduledRequest(post("/api/scheduled", { pane_id: "p1", text: "continue", send_at: "2026-11-05T11:00:00Z" }), "/api/scheduled", scheduled, { readOnly: false, device: "d" });
  expect(created?.status).toBe(201);
  const listed = await handleScheduledRequest(new Request("http://pc/api/scheduled"), "/api/scheduled", scheduled, { readOnly: false, device: "d" });
  expect(((await listed!.json()) as { messages: unknown[] }).messages).toHaveLength(1);
  expect(await handleScheduledRequest(new Request("http://pc/api/scheduledx"), "/api/scheduledx", scheduled, { readOnly: false, device: "d" })).toBeNull();
});
