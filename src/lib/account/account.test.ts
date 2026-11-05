import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FakeAccountService, WEB_REDIRECT } from "../../../shared/account-service-fake.ts";
import type { RelayDevice } from "../relay/device.ts";
import { myPcs, OFFLINE_AFTER_MS } from "./myPcs.ts";
import { AccountService, accountServiceOf, SignedOutError } from "./service.ts";
import { beginSignIn, finishSignIn, SignInError, signInReturn } from "./signin.ts";
import { memoryAccountStore } from "./store.ts";

const SERVICE = "https://account.example";
const REDIRECT = WEB_REDIRECT;
const PC_A = "a".repeat(32);
const PC_B = "b".repeat(32);

function serviceWithSignIn() {
  const fake = new FakeAccountService();
  fake.signInAs("github", "acct_1");
  fake.signInAs("apple", "acct_1");
  return { fake, fetch: fake.fetch };
}

async function signIn(service: ReturnType<typeof serviceWithSignIn>, store = memoryAccountStore(), now = Date.now) {
  const start = await beginSignIn("github", { store, service: SERVICE, redirectUri: REDIRECT, now });
  const location = (await service.fetch(start)).headers.get("location") ?? "";
  const returned = signInReturn(new URL(location).hash);
  if (returned === null) throw new Error("no sign-in came back");
  return { store, session: await finishSignIn(returned, { store, fetch: service.fetch, now }), returned };
}

function paired(serverId: string, name: string): RelayDevice {
  return { server_id: serverId, device_id: "0".repeat(16), private_key: {} as CryptoKey, public_spki: "", label: "Phone", server_public_key: "", relay: "wss://relay.example", name };
}

describe("signing in", () => {
  it("lists the account's PCs once the code comes back with the verifier that started it", async () => {
    const service = serviceWithSignIn();
    const { store, session } = await signIn(service);
    expect(session.account).toBe("acct_1");
    const client = new AccountService({ store, fetch: service.fetch });
    await client.putPc(PC_A, "p620");
    expect((await client.listPcs()).map((pc) => pc.label)).toEqual(["p620"]);
  });

  it("refuses a return this client did not start, and a return opened twice", async () => {
    const service = serviceWithSignIn();
    const { store, returned } = await signIn(service);
    await expect(finishSignIn(returned, { store, fetch: service.fetch })).rejects.toMatchObject({ code: "no_sign_in" });
    await beginSignIn("github", { store, service: SERVICE, redirectUri: REDIRECT });
    const forged = await finishSignIn({ code: "x", state: "someone-else" }, { store, fetch: service.fetch }).catch((error: unknown) => error);
    expect(forged).toBeInstanceOf(SignInError);
    expect((forged as SignInError).code).toBe("state_mismatch");
    // the waiting sign-in went with the forged return: the real one cannot follow it in
    expect(await store.get("pending")).toBeUndefined();
  });

  it("refuses a sign-in that came back after its time ran out", async () => {
    const service = serviceWithSignIn();
    const store = memoryAccountStore();
    let now = 1_000_000;
    const start = await beginSignIn("apple", { store, service: SERVICE, redirectUri: REDIRECT, now: () => now });
    const returned = signInReturn(new URL((await service.fetch(start)).headers.get("location") ?? "").hash);
    now += 11 * 60_000;
    await expect(finishSignIn(returned ?? { error: "x", state: "" }, { store, fetch: service.fetch, now: () => now })).rejects.toMatchObject({ code: "expired" });
  });

  it("refreshes an access token about to run out, and signs out when the refresh is refused", async () => {
    const service = serviceWithSignIn();
    let now = Date.now();
    const { store, session } = await signIn(service, memoryAccountStore(), () => now);
    const client = new AccountService({ store, fetch: service.fetch, now: () => now });
    now = session.expires_at;
    await client.listPcs();
    expect((await store.get("session"))?.access_token).not.toBe(session.access_token);
    // the spent refresh token comes back, as a leaked copy would: the service ends the whole sign-in
    const refreshed = await store.get("session");
    if (refreshed === undefined) throw new Error("the refresh kept no session");
    await store.set("session", { ...refreshed, refresh_token: session.refresh_token, expires_at: 0 });
    await expect(client.listPcs()).rejects.toBeInstanceOf(SignedOutError);
    expect(await store.get("session")).toBeUndefined();
  });
});

describe("which account service a page signs in with", () => {
  const page = (content: string | null) => ({ querySelector: () => content === null ? null : { getAttribute: () => content } });

  it("offers no sign-in without a service named, or with one reached over plain http beyond this machine", () => {
    expect(accountServiceOf(page(null))).toBeNull();
    expect(accountServiceOf(page("http://account.example"))).toBeNull();
    expect(accountServiceOf(page("not a url"))).toBeNull();
  });

  it("takes an https origin, or http on loopback, without its path", () => {
    expect(accountServiceOf(page("https://account.example/v1/"))).toBe("https://account.example");
    expect(accountServiceOf(page("http://127.0.0.1:8787"))).toBe("http://127.0.0.1:8787");
  });
});

describe("the account key", () => {
  it("is made once, cannot be exported, and stays the same", async () => {
    const store = memoryAccountStore();
    const [first, second] = await Promise.all([store.key(), store.key()]);
    expect(second).toBe(first);
    expect(first.private_key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", first.private_key)).rejects.toThrow();
  });

  it("lives in its own database: the service worker opens only ovis-relay, at the version the shell does", () => {
    const root = join(import.meta.dir, "../../..");
    const opens = (file: string) => [...readFileSync(join(root, file), "utf8").matchAll(/indexedDB\.open\(([^)]*)\)/g)].map(([, args]) => args);
    expect(opens("public/sw.js")).toEqual(['"ovis-relay", 2']);
    expect(opens("src/lib/relay/device.ts")).toEqual(['"ovis-relay", 2']);
    expect(opens("src/lib/account/store.ts")).toEqual(["DATABASE, 1"]);
  });
});

describe("My PCs", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  const recent = new Date(now - 60_000).toISOString();
  const stale = new Date(now - OFFLINE_AFTER_MS - 1).toISOString();

  it("marks a listed PC this device is not paired with as needing approval, and keeps a paired PC the account does not list", () => {
    const rows = myPcs([{ server_id: PC_B, label: "nuc", added_at: recent, last_seen_at: recent }], [paired(PC_A, "p620")], { now });
    expect(rows.map(({ name, state, listed }) => [name, state, listed])).toEqual([["p620", "paired", false], ["nuc", "needs-approval", true]]);
  });

  it("calls a PC offline once it stops coming by the service, and never one it has not seen", () => {
    const rows = myPcs([
      { server_id: PC_A, label: "p620", added_at: recent, last_seen_at: stale },
      { server_id: PC_B, label: "nuc", added_at: recent, last_seen_at: null },
    ], [paired(PC_A, "p620"), paired(PC_B, "nuc")], { now });
    expect(rows.map(({ name, state }) => [name, state])).toEqual([["nuc", "paired"], ["p620", "offline"]]);
  });

  it("says a PC needs an update when its Ovis has no accounts", () => {
    const rows = myPcs([], [paired(PC_A, "p620")], { now, outdated: new Set([PC_A]) });
    expect(rows[0]?.state).toBe("needs-update");
  });

  it("names a paired PC by its own name, not the directory's label", () => {
    const rows = myPcs([{ server_id: PC_A, label: "renamed by anyone", added_at: recent, last_seen_at: recent }], [paired(PC_A, "p620")], { now });
    expect(rows[0]?.name).toBe("p620");
  });
});
