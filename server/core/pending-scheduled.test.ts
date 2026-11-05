import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as herdr from "../herdr/client.ts";
import * as processStart from "../process-start.ts";
import { createPendingDelivery } from "./pending.ts";

afterEach(() => mock.restore());

/** A Codex pane (pid 41001 in front of shell 41000) and the PC's pending delivery with no connection at all (#2919). */
function delivery(status: string, startTimeoutMs?: number) {
  const writes: string[] = [];
  const front = { pid: 41001, name: "codex" };
  spyOn(herdr, "paneProcessInfo").mockImplementation(async () =>
    ({ pane_id: "p", shell_pid: 41000, foreground_processes: [{ argv: [front.name], ...front }] }) as Awaited<ReturnType<typeof herdr.paneProcessInfo>>);
  spyOn(processStart, "processStartedAtAsync").mockResolvedValue(1000);
  const shown = { screen: "› Ask Codex to do anything\n" };
  spyOn(herdr, "paneRead").mockImplementation(async () => ({ text: shown.screen }) as Awaited<ReturnType<typeof herdr.paneRead>>);
  spyOn(herdr, "paneSendText").mockImplementation(async (_pane, text) => { writes.push(text); });
  spyOn(herdr, "paneSendKeys").mockImplementation(async (_pane, keys) => { writes.push(keys.join(",")); });
  const pane = { pane_id: "p", terminal_id: "p", workspace_id: "w", tab_id: "t", agent: "codex", agent_status: status, focused: false, revision: 0 };
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T,>(_pane: string, run: () => T | Promise<T>): Promise<T> => { const next = tail.catch(() => {}).then(run); tail = next; return next; };
  const pending = createPendingDelivery({
    options: { submitDelayMs: 0, ...(startTimeoutMs === undefined ? {} : { pendingStartTimeoutMs: startTimeoutMs }) }, clients: new Set(), attachments: new Map(), sight: () => { throw new Error("no connection"); }, serialize,
    lastTyped: new Map(), submitText: async () => { throw new Error("not the immediate path"); }, authorizeSocket: () => {},
    clientSnapshot: async () => ({ panes: [pane] }), omo: { sessionOf: () => null }, SUBMIT_DEADLINE_MS: 1000, SUBMIT_DELAY_MS: 0, TYPED_SETTLE_MS: 0,
  } as unknown as Parameters<typeof createPendingDelivery>[0]);
  return { pending, writes, pane, front, shown };
}

it("types a scheduled message with no connection open: a paste and its Enter", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toEqual({ ok: true });
  expect(d.writes).toEqual(["\u001b[200~continue\u001b[201~", "Enter"]);
});

it("keeps a scheduled message for the agent's next turn while it works, typing nothing", async () => {
  const d = delivery("working");
  const identity = await d.pending.scheduledIdentity("p");
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toMatchObject({ ok: false, code: "pending_wait" });
  expect(d.writes).toEqual([]);
});

it("refuses a scheduled message once another agent process runs in the pane", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  d.front.pid = 41002;
  expect(await d.pending.sendScheduled("p", "continue", identity, true, () => {})).toMatchObject({ ok: false, code: "pending_target_changed" });
  expect(d.writes).toEqual([]);
});

it("types nothing once the scheduler withdraws its authority", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  const revoked = () => { throw new herdr.HerdrError("device_revoked", "gone"); };
  expect(await d.pending.sendScheduled("p", "continue", identity, true, revoked)).toMatchObject({ ok: false, code: "device_revoked" });
  expect(d.writes).toEqual([]);
});

it("types nothing when the shell is in front where herdr still names the agent", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  d.front.pid = 41000;
  d.front.name = "bash";
  expect((await d.pending.sendScheduled("p", "continue", identity, true, () => {})).ok).toBe(false);
  expect(d.writes).toEqual([]);
});

it("keeps a second scheduled message for the turn the first one started", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  expect(await d.pending.sendScheduled("p", "first", identity, true, () => {})).toEqual({ ok: true });
  expect(await d.pending.sendScheduled("p", "second", identity, true, () => {})).toMatchObject({ ok: false, code: "pending_wait" });
  expect(d.writes).toEqual(["\u001b[200~first\u001b[201~", "Enter"]);
});

it("holds the next scheduled message for review when the turn the last one started was never confirmed", async () => {
  const d = delivery("idle", 0);
  const identity = await d.pending.scheduledIdentity("p");
  expect(await d.pending.sendScheduled("p", "first", identity, true, () => {})).toEqual({ ok: true });
  d.pending.pending.expire();
  expect(await d.pending.sendScheduled("p", "second", identity, true, () => {})).toMatchObject({ ok: false, code: "pending_turn_unconfirmed" });
  d.pending.pending.status("p", "idle");
  expect(await d.pending.sendScheduled("p", "second", identity, true, () => {})).toEqual({ ok: true });
});

it("types nothing into a password prompt that wrapped, with no client to tell the pane's width", async () => {
  const d = delivery("idle");
  const identity = await d.pending.scheduledIdentity("p");
  d.shown.screen = "Enter passphrase for key\n'/tmp/key': ";
  expect((await d.pending.sendScheduled("p", "continue", identity, true, () => {})).ok).toBe(false);
  expect(d.writes).toEqual([]);
});
