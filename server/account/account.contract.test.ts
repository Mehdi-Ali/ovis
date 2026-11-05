import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signAccountRecord, type AccountRecord, type UnsignedAccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { ACCOUNT_FEATURE, FrameType } from "../../shared/relay-mux.ts";
import { DeviceStore, mergeAccountTombstones, readDeviceRegistry } from "../devices.ts";
import { mergeRegistries } from "../state-merge.ts";
import { rotateRelayIdentity } from "../relay/identity.ts";
import { bounded, relayConnection, relayDevice, relayFixture } from "../relay/test-helpers.ts";
import { AccountMailbox } from "./mailbox.ts";
import { applyAccountRecords } from "./records.ts";

type Fixture = ReturnType<typeof relayFixture>;
type Link = Awaited<ReturnType<typeof relayConnection>>;
type Device = Awaited<ReturnType<typeof relayDevice>>;

const SERVER_ID = "0123456789abcdef0123456789abcdef";
const ACCOUNT = "acct_1";
const guard = [["content-type", "application/json"], ["x-herdr-machine", "1"]] as const;
const fixtures: Fixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function fixture(): Fixture {
  const made = relayFixture();
  fixtures.push(made);
  return made;
}

interface AccountKey { keys: CryptoKeyPair; spki: string }

async function accountKey(): Promise<AccountKey> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

const issued = () => new Date().toISOString();

const sign = (record: UnsignedAccountRecord, key: AccountKey) => signAccountRecord(record, key.keys.privateKey);

const add = (signer: AccountKey, key: string, account = ACCOUNT) =>
  sign({ v: 1, kind: "add", account, key, label: "Mac app", role: "drive", issued_at: issued(), id: newRecordId(), signer: signer.spki }, signer);

const remove = (signer: AccountKey, key: string) =>
  sign({ v: 1, kind: "remove", account: ACCOUNT, key, issued_at: issued(), id: newRecordId(), signer: signer.spki }, signer);

const linkRecord = (device: Device, key: AccountKey, overrides: Partial<Record<"server_id" | "device_id" | "old_key", string>> = {}) =>
  sign({ v: 1, kind: "link", account: ACCOUNT, key: key.spki, server_id: SERVER_ID, device_id: device.id, old_key: device.publicKey,
    issued_at: issued(), id: newRecordId(), signer: key.spki, ...overrides }, key);

async function signedIn(f: Fixture, device: Device): Promise<Link> {
  const link = await relayConnection(f);
  await link.auth(device);
  return link;
}

async function post(link: Link, target: string, body: unknown) {
  const request = link.open(target, { method: "POST", headers: guard, body: "stream" });
  void request.stream.sendBody(new Response(JSON.stringify(body)).body ?? new ReadableStream()).catch(() => {});
  const response = await request.response;
  return { status: response.status, body: await response.json() as Record<string, unknown> & { error?: { code: string }; results?: { outcome: string; code?: string }[] } };
}

async function status(link: Link) {
  return await (await link.open("/api/account/status").response).json() as { account: string | null; members: number; unlinked: string[] };
}

/** A relay device that linked its row to the account: the device as it signs in from then on. */
async function member(f: Fixture): Promise<{ device: Device; key: AccountKey; link: Link }> {
  const legacy = await relayDevice(f);
  const key = await accountKey();
  const link = await signedIn(f, legacy);
  expect((await post(link, "/api/account/link", { record: await linkRecord(legacy, key) })).status).toBe(200);
  return { device: { keys: key.keys, publicKey: key.spki, id: legacy.id }, key, link };
}

function registryRow(f: Fixture, id: string) {
  const registry = readDeviceRegistry(join(f.stateDir, "devices.json"));
  return registry.kind === "ok" ? registry.devices.find((device) => device.id === id) : undefined;
}

test("a device links its row to the account over its own session, which gives the PC its first member", async () => {
  const f = fixture();
  const legacy = await relayDevice(f);
  const key = await accountKey();
  const link = await signedIn(f, legacy);
  expect((await status(link)).account).toBeNull();
  expect((await post(link, "/api/account/link", { record: await linkRecord(legacy, key) })).status).toBe(200);
  expect(registryRow(f, legacy.id)).toMatchObject({ relay_public_key: key.spki, account: ACCOUNT });
  // the same session goes on, and from now on the device signs in with the account key
  expect(await status(link)).toEqual(expect.objectContaining({ account: ACCOUNT, members: 1, unlinked: [] }));
  const again = await relayConnection(f);
  expect((await again.auth({ keys: key.keys, publicKey: key.spki, id: legacy.id })).device_id).toBe(legacy.id);
});

test("a link is refused for another row, another PC, a stale key, a key another row holds, or off the relay", async () => {
  const f = fixture();
  const mine = await relayDevice(f);
  const other = await relayDevice(f);
  const key = await accountKey();
  const link = await signedIn(f, mine);
  const cases: [Promise<AccountRecord>, string][] = [
    [linkRecord(mine, key, { device_id: other.id }), "link_not_owner"],
    [linkRecord(mine, key, { server_id: "f".repeat(32) }), "link_not_owner"],
    [linkRecord(mine, key, { old_key: other.publicKey }), "link_not_owner"],
    [linkRecord(mine, { keys: other.keys, spki: other.publicKey }), "key_in_use"],
  ];
  for (const [record, code] of cases) expect((await post(link, "/api/account/link", { record: await record })).body.error?.code).toBe(code);
  const direct = await fetch(`http://127.0.0.1:${f.app.port}/api/account/link`, {
    method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1", origin: `http://127.0.0.1:${f.app.port}` },
    body: JSON.stringify({ record: await linkRecord(mine, key) }),
  });
  expect(((await direct.json()) as { error: { code: string } }).error.code).toBe("link_not_owner");
  expect(registryRow(f, mine.id)?.account).toBeUndefined();
});

test("a PC left half moved lists the relay rows account removal does not reach, until each links on its next connection", async () => {
  const f = fixture();
  const { link } = await member(f);
  const later = await relayDevice(f);
  expect((await status(link)).unlinked).toEqual([later.id]);
  const key = await accountKey();
  expect((await post(await signedIn(f, later), "/api/account/link", { record: await linkRecord(later, key) })).status).toBe(200);
  expect(await status(link)).toEqual(expect.objectContaining({ members: 2, unlinked: [] }));
});

test("a member's add puts a device on this PC with who added it; a stranger's, another account's, a forged or a malformed one change nothing", async () => {
  const f = fixture();
  const { device, key, link } = await member(f);
  const [joining, stranger] = [await accountKey(), await accountKey()];
  const valid = await add(key, joining.spki);
  const results = (await post(link, "/api/account/records", { records: [
    valid, await add(stranger, (await accountKey()).spki), await add(key, (await accountKey()).spki, "acct_2"),
    { ...await add(key, (await accountKey()).spki), label: "Forged" }, { kind: "add" },
  ] })).body.results;
  expect(results?.map(({ outcome, code }) => code ?? outcome)).toEqual(["applied", "signer_not_member", "account_mismatch", "signature_invalid", "record_invalid"]);
  const added = f.app.context.services.devices.list(null).find((row) => row.label === "Mac app");
  expect(registryRow(f, added!.id)).toMatchObject({ relay_public_key: joining.spki, account: ACCOUNT, added_by: device.id });
  expect((await post(link, "/api/account/records", { records: [valid] })).body.results?.[0]?.outcome).toBe("unchanged");
  const joined = await relayConnection(f);
  expect((await joined.auth({ keys: joining.keys, publicKey: joining.spki, id: added!.id })).role).toBe("drive");
});

test("a member's remove cuts the device off at once and keeps it out: its add replayed is refused until this PC pairs it again", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const lost = await accountKey();
  const replay = await add(key, lost.spki);
  await post(link, "/api/account/records", { records: [replay] });
  const lostId = f.app.context.services.devices.list(null).find((row) => row.label === "Mac app")!.id;
  const lostLink = await relayConnection(f);
  await lostLink.auth({ keys: lost.keys, publicKey: lost.spki, id: lostId });

  expect((await post(link, "/api/account/records", { records: [await remove(key, lost.spki)] })).body.results?.[0]?.outcome).toBe("applied");
  expect(await bounded(lostLink.serverError)).toBe("auth_revoked");
  expect((await post(link, "/api/account/records", { records: [replay] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "tombstoned" });

  // a pairing made on this PC wins over the account's removal
  const again = await relayConnection(f);
  expect((await again.pair(f.app.context.services.devices.startPairing().code, lost.spki)).role).toBe("drive");
  expect(f.app.context.services.devices.isTombstoned(lost.spki)).toBe(false);
});

test("a member removed from the account signs nothing more here", async () => {
  const f = fixture();
  const first = await member(f);
  const second = await member(f);
  await post(second.link, "/api/account/records", { records: [await remove(second.key, first.key.spki)] });
  const late = await add(first.key, (await accountKey()).spki);
  expect((await post(second.link, "/api/account/records", { records: [late] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "signer_not_member" });
});

test("only a member of the account enrolls this PC, and with add records only", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const outsider = await signedIn(f, await relayDevice(f));
  const records = [await add(key, (await accountKey()).spki), await add(key, (await accountKey()).spki)];
  expect((await post(outsider, "/api/account/enroll", { account: ACCOUNT, records })).body.error?.code).toBe("account_required");
  expect((await post(link, "/api/account/enroll", { account: "acct_2", records })).body.error?.code).toBe("account_required");
  expect((await post(link, "/api/account/enroll", { account: ACCOUNT, records: [await remove(key, (await accountKey()).spki)] })).body.error?.code).toBe("record_invalid");
  expect((await post(link, "/api/account/enroll", { account: ACCOUNT, records })).body.results?.map(({ outcome }) => outcome)).toEqual(["applied", "applied"]);
});

test("a watch device reaches none of the account routes", async () => {
  const f = fixture();
  const watcher = await signedIn(f, await relayDevice(f, "watch"));
  expect((await (await watcher.open("/api/account/status").response).json() as { error: { code: string } }).error.code).toBe("read_only");
  expect((await post(watcher, "/api/account/records", { records: [] })).body.error?.code).toBe("read_only");
});

test("the PC selects the account feature for a client that offers it", async () => {
  const f = fixture();
  const link = await relayConnection(f);
  link.mux.sendSession({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features: [ACCOUNT_FEATURE], required_features: [] } });
  const welcome = await new Promise<string[]>((resolve) => { link.onFrame = (frame) => { if (frame.type === FrameType.WELCOME) resolve([...frame.payload.features]); }; });
  expect(welcome).toEqual([ACCOUNT_FEATURE]);
});

test("the PC collects its mailbox with a proof of its relay key and applies it: removals reach a PC that was off", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const lost = await accountKey();
  await post(link, "/api/account/records", { records: [await add(key, lost.spki)] });
  const identity = rotateRelayIdentity(f.stateDir);
  const service = new FakeAccountService();
  const token = service.issueToken(ACCOUNT);
  await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", body: JSON.stringify({ label: "PC" }), headers: { authorization: `Bearer ${token}` } }));
  const stranger = await accountKey();
  for (const record of [await remove(stranger, key.spki), await remove(key, lost.spki)]) {
    await service.fetch(new Request("https://account.test/v1/records", { method: "POST", body: JSON.stringify({ server_ids: [identity.server_id], record }), headers: { authorization: `Bearer ${token}` } }));
  }
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => identity, service: "https://account.test", fetch: service.fetch });
  expect(await mailbox.pull()).toBe(1);
  expect(mailbox.error).toBeNull();
  expect(f.app.context.services.devices.hasKey(lost.spki)).toBe(false);
  expect(f.app.context.services.devices.hasKey(key.spki)).toBe(true);
  // the refused record is acknowledged with the applied one, so neither waits in the mailbox
  expect(service.mailbox(identity.server_id, ACCOUNT)).toEqual([]);
});

test("a new relay identity leaves the account: its members go with the relay pairings, and nothing is collected", async () => {
  const f = fixture();
  const { link } = await member(f);
  expect((await status(link)).account).toBe(ACCOUNT);
  await f.app.context.services.relay.resetIdentity();
  expect(f.app.context.services.devices.account()).toBeNull();
  const service = new FakeAccountService();
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => f.app.context.services.relay.currentIdentity(), service: "https://account.test", fetch: service.fetch });
  expect(await mailbox.pull()).toBe(0);
  expect(service.requests).toEqual([]);
});

test("a revoke on this PC wins over the account: the device's signed add replayed is refused", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const record = await add(key, (await accountKey()).spki);
  await post(link, "/api/account/records", { records: [record] });
  f.app.context.services.devices.revoke(f.app.context.services.devices.list(null).find((row) => row.label === "Mac app")!.id);
  expect((await post(link, "/api/account/records", { records: [record] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "tombstoned" });
});

test("a code started through the relay does not let a removed key back in", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const removed = await accountKey();
  await post(link, "/api/account/records", { records: [await remove(key, removed.spki)] });
  const code = (await post(link, "/api/devices/pair/start", {})).body as unknown as { code: string };
  await expect((await relayConnection(f)).pair(code.code, removed.spki)).rejects.toThrow();
  expect(f.app.context.services.devices.isTombstoned(removed.spki)).toBe(true);
});

test("a session signed in with a row's old key cannot move the row on to a key of its choosing", async () => {
  const f = fixture();
  const legacy = await relayDevice(f);
  const oldSession = await signedIn(f, legacy);
  const current = await accountKey();
  expect((await post(oldSession, "/api/account/link", { record: await linkRecord(legacy, current) })).status).toBe(200);
  const takeover = await linkRecord(legacy, await accountKey(), { old_key: current.spki });
  expect((await post(oldSession, "/api/account/link", { record: takeover })).body.error?.code).toBe("link_not_owner");
  expect(registryRow(f, legacy.id)?.relay_public_key).toBe(current.spki);
});

test("a link cannot give a row the key another row holds, not even the key it signed in with", async () => {
  const f = fixture();
  const first = await member(f);
  const store = f.app.context.services.devices;
  const duplicate = store.pairRelay(store.startPairing().code, "Duplicate", first.key.spki)!.device;
  const twin = { id: duplicate.id, keys: first.key.keys, publicKey: first.key.spki };
  const session = await signedIn(f, twin);
  expect((await post(session, "/api/account/link", { record: await linkRecord(twin, first.key) })).body.error?.code).toBe("key_in_use");
});

test("a remove signed before this PC paired the key again leaves the new pairing be", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const lost = await accountKey();
  const removal = await remove(key, lost.spki);
  await post(link, "/api/account/records", { records: [removal] });
  expect((await (await relayConnection(f)).pair(f.app.context.services.devices.startPairing().code, lost.spki)).role).toBe("drive");
  expect((await post(link, "/api/account/records", { records: [removal] })).body.results?.[0]?.outcome).toBe("unchanged");
  expect(f.app.context.services.devices.hasKey(lost.spki)).toBe(true);
});

/** A state dir as a stop between two writes leaves it: one relay row and a tombstone for its key. */
async function interrupted(rowCreated: string, removed: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-account-interrupted-"));
  const key = (await accountKey()).spki;
  const row = { id: "00112233445566aa", label: "Phone", role: "drive", token_hash: "0".repeat(64), relay_public_key: key, account: ACCOUNT, created_at: rowCreated, last_seen_at: null };
  writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: rowCreated, devices: [row] }), { mode: 0o600 });
  writeFileSync(join(stateDir, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key, account: ACCOUNT, record_id: "r", removed_at: removed }] }), { mode: 0o600 });
  return { stateDir, key, store: () => new DeviceStore(stateDir) };
}

test("a removal cut off between its two writes is finished when the PC starts", async () => {
  const state = await interrupted("2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
  try {
    const store = state.store();
    expect(store.error).toBeNull();
    expect(store.hasKey(state.key)).toBe(false);
    expect(store.isTombstoned(state.key)).toBe(true);
    expect(store.list(null)).toEqual([]);
  } finally { rmSync(state.stateDir, { recursive: true, force: true }); }
});

test("a pairing on this PC cut off before it cleared the tombstone keeps its device when the PC starts", async () => {
  const state = await interrupted("2026-11-03T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
  try {
    const store = state.store();
    expect(store.hasKey(state.key)).toBe(true);
    expect(store.isTombstoned(state.key)).toBe(false);
  } finally { rmSync(state.stateDir, { recursive: true, force: true }); }
});

test("an unreadable tombstone file refuses every account way in, and the mailbox collects nothing until it is fixed", async () => {
  const f = fixture();
  const { device, key } = await member(f);
  writeFileSync(join(f.stateDir, "account-tombstones.json"), "{not json", { mode: 0o600 });
  const store = new DeviceStore(f.stateDir);
  expect(store.accountError).not.toBeNull();
  expect((await applyAccountRecords(store, [await remove(key, (await accountKey()).spki)]))[0]).toMatchObject({ outcome: "refused", code: "account_unavailable" });
  expect(store.pairRelayApproved("Phone", (await accountKey()).spki, { path: "account", addedBy: device.id })).toBeNull();
  const service = new FakeAccountService();
  const mailbox = new AccountMailbox({ devices: store, identity: () => rotateRelayIdentity(f.stateDir), service: "https://account.test", fetch: service.fetch });
  expect(await mailbox.pull()).toBe(0);
  expect(mailbox.error).not.toBeNull();
  expect(service.requests).toEqual([]);
});

test("two state dirs end with every tombstone of both", () => {
  const [a, b] = [mkdtempSync(join(tmpdir(), "ovis-account-a-")), mkdtempSync(join(tmpdir(), "ovis-account-b-"))];
  try {
    const key = "a-removed-key";
    writeFileSync(join(a, "account-tombstones.json"), JSON.stringify({ v: 1, tombstones: [{ key, account: ACCOUNT, record_id: "r", removed_at: "2026-11-02T00:00:00.000Z" }] }));
    writeFileSync(join(b, "account-tombstones.pending.json"), JSON.stringify({ v: 1, tombstones: [{ key: "a-pending-key", account: "", record_id: "local", removed_at: "2026-11-03T00:00:00.000Z" }] }));
    mergeAccountTombstones(a, b);
    expect(new DeviceStore(b).isTombstoned(key)).toBe(true);
    expect(new DeviceStore(a).isTombstoned("a-pending-key")).toBe(true);
  } finally { for (const dir of [a, b]) rmSync(dir, { recursive: true, force: true }); }
});

test("a bad account service address shows as the mailbox's error instead of stopping the PC", async () => {
  const f = fixture();
  await member(f);
  const mailbox = new AccountMailbox({ devices: f.app.context.services.devices, identity: () => rotateRelayIdentity(f.stateDir), service: new Error("The account service must be https") });
  expect(await mailbox.pull()).toBe(0);
  expect(mailbox.error).toBe("The account service must be https");
});

test("a PC that was off and gets a member's add and remove together ends without the device", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const passing = await accountKey();
  const signedEarlier = new Date(Date.now() - 60_000).toISOString();
  const records = [
    await sign({ v: 1, kind: "add", account: ACCOUNT, key: passing.spki, label: "Mac app", role: "drive", issued_at: signedEarlier, id: newRecordId(), signer: key.spki }, key),
    await sign({ v: 1, kind: "remove", account: ACCOUNT, key: passing.spki, issued_at: signedEarlier, id: newRecordId(), signer: key.spki }, key),
  ];
  expect((await post(link, "/api/account/records", { records })).body.results?.map(({ outcome }) => outcome)).toEqual(["applied", "applied"]);
  expect(f.app.context.services.devices.hasKey(passing.spki)).toBe(false);
  expect(f.app.context.services.devices.isTombstoned(passing.spki)).toBe(true);
});

test("a pairing by a code started through the relay does not outlast an older remove", async () => {
  const f = fixture();
  const { device, key, link } = await member(f);
  const target = await accountKey();
  const removal = await sign({ v: 1, kind: "remove", account: ACCOUNT, key: target.spki, issued_at: new Date(Date.now() - 60_000).toISOString(), id: newRecordId(), signer: key.spki }, key);
  const code = (await post(link, "/api/devices/pair/start", {})).body as unknown as { code: string };
  await (await relayConnection(f)).pair(code.code, target.spki);
  const row = f.app.context.services.devices.list(null).find((d) => d.label === "New phone")!;
  expect(registryRow(f, row.id)?.added_by).toBe(device.id);
  expect((await post(link, "/api/account/records", { records: [removal] })).body.results?.[0]?.outcome).toBe("applied");
  expect(f.app.context.services.devices.hasKey(target.spki)).toBe(false);
});

test("an add for a key off the curve is refused and leaves devices.json readable", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const offCurve = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE" + "A".repeat(86);
  expect((await post(link, "/api/account/records", { records: [await add(key, offCurve)] })).body.results?.[0]).toMatchObject({ outcome: "refused", code: "record_invalid" });
  expect(readDeviceRegistry(join(f.stateDir, "devices.json")).kind).toBe("ok");
});

test("a revoke while the tombstone file cannot be read still keeps the key out once it is fixed", async () => {
  const f = fixture();
  const { key, link } = await member(f);
  const extra = await accountKey();
  const record = await add(key, extra.spki);
  await post(link, "/api/account/records", { records: [record] });
  const saved = await Bun.file(join(f.stateDir, "account-tombstones.json")).exists() ? await Bun.file(join(f.stateDir, "account-tombstones.json")).text() : JSON.stringify({ v: 1, tombstones: [] });
  writeFileSync(join(f.stateDir, "account-tombstones.json"), "{broken", { mode: 0o600 });
  const broken = new DeviceStore(f.stateDir);
  expect(broken.revoke(broken.list(null).find((row) => row.label === "Mac app")!.id)).toBe(true);
  writeFileSync(join(f.stateDir, "account-tombstones.json"), saved, { mode: 0o600 });
  const fixed = new DeviceStore(f.stateDir);
  expect(fixed.accountError).toBeNull();
  expect(fixed.isTombstoned(extra.spki)).toBe(true);
  expect((await applyAccountRecords(fixed, [record]))[0]).toMatchObject({ outcome: "refused", code: "tombstoned" });
});

test("merging two state dirs keeps a link done in either", () => {
  const linked = { id: "00112233445566aa", label: "Phone", role: "drive" as const, token_hash: "0".repeat(64), relay_public_key: "NEW", account: ACCOUNT, created_at: "2026-11-01T00:00:00.000Z", last_seen_at: null };
  const old = { ...linked, relay_public_key: "OLD", account: undefined };
  const ids = new Set([linked.id]);
  const merged = mergeRegistries({ gate_closed_at: null, devices: [old] }, { gate_closed_at: null, devices: [linked] }, { own: ids, other: ids });
  expect(merged.devices[0]).toMatchObject({ relay_public_key: "NEW", account: ACCOUNT });
});

test("a member's relay code lets nobody in once the member is revoked", async () => {
  const f = fixture();
  const starter = await member(f);
  const code = (await post(starter.link, "/api/devices/pair/start", {})).body as unknown as { code: string };
  f.app.context.services.devices.revoke(starter.device.id);
  await expect((await relayConnection(f)).pair(code.code, (await accountKey()).spki)).rejects.toThrow();
});

test("on a PC in no account a code a relay device started still pairs a new device", async () => {
  const f = fixture();
  const starter = await signedIn(f, await relayDevice(f));
  const code = (await post(starter, "/api/devices/pair/start", {})).body as unknown as { code: string };
  expect((await (await relayConnection(f)).pair(code.code, (await accountKey()).spki)).role).toBe("drive");
});
