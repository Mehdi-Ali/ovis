import { afterEach, expect, it } from "bun:test";
import { AccountMailbox } from "../../../server/account/mailbox.ts";
import { rotateRelayIdentity } from "../../../server/relay/identity.ts";
import type { RelayIdentity } from "../../../server/relay/identity.ts";
import { relayConnection, relayDevice, relayFixture } from "../../../server/relay/test-helpers.ts";
import { accountDeviceId, exportAccountKey } from "../../../shared/account-records.ts";
import { FakeAccountService } from "../../../shared/account-service-fake.ts";
import { importPublicKey } from "../../../shared/relay-e2ee.ts";
import type { RelayDevice } from "../relay/device.ts";
import { MemoryDeviceStore } from "../relay/device.test.ts";
import { admitToAccount, linkThisDevice, needsLink, pcAccountStatus, takeIntroduction } from "./join.ts";
import { myPcs } from "./myPcs.ts";
import { AccountService } from "./service.ts";
import { memoryAccountStore } from "./store.ts";
import type { AccountKey } from "./store.ts";

const ACCOUNT = "acct_1";
const SERVICE = "https://account.test";
const guard = [["content-type", "application/json"], ["x-herdr-machine", "1"]] as const;

type Fixture = ReturnType<typeof relayFixture>;
type Link = Awaited<ReturnType<typeof relayConnection>>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

/** A PC with a relay identity of its own, as the relay would route to it. */
function pc(): { f: Fixture; identity: RelayIdentity } {
  const f = relayFixture();
  fixtures.push(f);
  return { f, identity: rotateRelayIdentity(f.stateDir) };
}

/** This client's requests to the PC, through its own signed-in relay session. */
const pcFetch = (link: Link) => async (path: string, init?: RequestInit): Promise<Response> => {
  if ((init?.method ?? "GET") === "GET") return link.open(path).response;
  const request = link.open(path, { method: "POST", headers: guard, body: "stream" });
  void request.stream.sendBody(new Response(init?.body ?? null).body ?? new ReadableStream()).catch(() => {});
  return request.response;
};

async function accountKey(): Promise<AccountKey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { private_key: pair.privateKey, public_spki: await exportAccountKey(pair.publicKey) };
}

/** A phone paired with the PC by QR code before the account: a key of its own for that PC. */
async function qrPairing(at: ReturnType<typeof pc>, store: MemoryDeviceStore, name: string): Promise<RelayDevice> {
  const device = await relayDevice(at.f);
  return store.update(at.identity.server_id, () => ({
    server_id: at.identity.server_id, server_public_key: at.identity.public_key, relay: "wss://relay.example", name,
    device_id: device.id, private_key: device.keys.privateKey, public_spki: device.publicKey, label: "Phone",
  }));
}

/** Signs in to the PC through the relay with whatever key the saved pairing holds now. */
async function connect(at: ReturnType<typeof pc>, saved: RelayDevice): Promise<Link> {
  const link = await relayConnection(at.f, { serverId: at.identity.server_id });
  if (saved.device_id === null) throw new Error("not admitted");
  await link.auth({ keys: { privateKey: saved.private_key } as CryptoKeyPair, publicKey: saved.public_spki, id: saved.device_id });
  return link;
}

it("moves QR pairings into the account one PC at a time, and calls a PC it has not reached yet not covered", async () => {
  const [a, b] = [pc(), pc()];
  const store = new MemoryDeviceStore();
  const key = await accountKey();
  const onA = await qrPairing(a, store, "p620");
  await qrPairing(b, store, "nuc");
  const link = await connect(a, onA);
  expect(needsLink(await pcAccountStatus(pcFetch(link)), onA, ACCOUNT)).toBe(true);
  const linked = await linkThisDevice({ fetch: pcFetch(link), device: onA, key, account: ACCOUNT, store });
  expect(linked.public_spki).toBe(key.public_spki);
  expect(await pcAccountStatus(pcFetch(link))).toEqual({ account: ACCOUNT, unlinked: [] });
  // the linked pairing signs in with the account key from now on
  await connect(a, linked);
  const rows = myPcs([], await store.list(), { now: Date.now(), accountKey: key.public_spki });
  expect(rows.map(({ name, linked: covered }) => [name, covered])).toEqual([["nuc", false], ["p620", true]]);
  expect(b.f.app.context.services.devices.accountRows().unlinked).toHaveLength(1);
});

it("leaves a pairing with a PC of another account as it is", () => {
  const device = { device_id: "ab".repeat(8) } as RelayDevice;
  expect(needsLink({ account: "acct_other", unlinked: ["ab".repeat(8)] }, device, ACCOUNT)).toBe(false);
});

it("brings an approved device into every PC of the account: the add waits in an offline PC's mailbox, and the introduction signs it in there", async () => {
  const [x, y] = [pc(), pc()];
  const approverKey = await accountKey();
  const phone = new MemoryDeviceStore();
  // the approving phone: already a member of both PCs
  const onX = await linkThisDevice({ fetch: pcFetch(await connect(x, await qrPairing(x, phone, "p620"))), device: (await phone.get(x.identity.server_id))!, key: approverKey, account: ACCOUNT, store: phone });
  await linkThisDevice({ fetch: pcFetch(await connect(y, await qrPairing(y, phone, "nuc"))), device: (await phone.get(y.identity.server_id))!, key: approverKey, account: ACCOUNT, store: phone });
  const service = new FakeAccountService();
  const accountStore = memoryAccountStore();
  await accountStore.set("session", { service: SERVICE, account: ACCOUNT, provider: "github", access_token: service.issueToken(ACCOUNT), refresh_token: "r", expires_at: Date.now() + 3600_000 });
  const account = new AccountService({ store: accountStore, fetch: service.fetch });
  for (const [at, label] of [[x, "p620"], [y, "nuc"]] as const) await account.putPc(at.identity.server_id, { label, public_key: Array.from(importPublicKey(at.identity.public_key), (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.example" });
  // PC X let the Mac in on this phone's remote approval
  const mac = await accountKey();
  const admitted = x.f.app.context.services.devices.addAccountDevice({ id: accountDeviceId(x.identity.server_id, mac.public_spki), key: mac.public_spki, label: "Mac app", role: "drive", account: ACCOUNT, addedBy: onX.device_id! });
  await admitToAccount({
    fetch: pcFetch(await connect(x, onX)), service: account, key: approverKey, account: ACCOUNT, joining: { key: mac.public_spki, label: "Mac app" },
    through: x.identity.server_id, paired: await phone.list(), directory: (await account.listPcs()).map((entry) => entry.server_id),
  });
  // PC Y was off: it finds the add in its mailbox when it comes back
  expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(false);
  await new AccountMailbox({ devices: y.f.app.context.services.devices, identity: () => y.identity, service: SERVICE, fetch: service.fetch }).pull();
  expect(y.f.app.context.services.devices.hasKey(mac.public_spki)).toBe(true);
  // the Mac learns PC Y from X and signs in there with the account key alone
  const macStore = new MemoryDeviceStore();
  const onXForMac = await macStore.update(x.identity.server_id, () => ({ server_id: x.identity.server_id, server_public_key: x.identity.public_key, relay: "wss://relay.example", device_id: admitted.id, private_key: mac.private_key, public_spki: mac.public_spki, label: "Mac app" }));
  const introduced = await takeIntroduction({ fetch: pcFetch(await connect(x, onXForMac)), key: mac, label: "Mac app", store: macStore });
  expect(introduced.map((device) => [device.server_id, device.device_id])).toEqual([[y.identity.server_id, accountDeviceId(y.identity.server_id, mac.public_spki)]]);
  const onY = await macStore.get(y.identity.server_id);
  if (!onY) throw new Error("no introduction for Y");
  await connect(y, onY);
});
