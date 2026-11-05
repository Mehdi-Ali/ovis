import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { bytesToHex } from "@noble/hashes/utils.js";
import { exportAccountKey, newRecordId, signAccountRecord, type AccountRecord } from "./account-records.ts";
import { FakeAccountService, MAILBOX_TTL_MS } from "./account-service-fake.ts";
import { answerServerChallenge, deriveServerId, serverChallenge, verifyServerProof, type ProofRoute } from "./relay-server-proof.ts";

const BASE = "https://account.test";

async function client() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { pair, spki: await exportAccountKey(pair.publicKey) };
}

function pc() {
  const keys = nacl.box.keyPair();
  return { keys, serverId: deriveServerId(keys.publicKey), publicKey: bytesToHex(keys.publicKey) };
}

const post = (path: string, body: unknown, token?: string) => new Request(BASE + path, {
  method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

async function removeRecord(account: string, signer: Awaited<ReturnType<typeof client>>, key: string): Promise<AccountRecord> {
  return signAccountRecord({ v: 1, kind: "remove", account, key, issued_at: new Date().toISOString(), id: newRecordId(), signer: signer.spki }, signer.pair.privateKey);
}

async function pull(service: FakeAccountService, machine: ReturnType<typeof pc>, ack: number | null, role: ProofRoute["role"] = "account") {
  const challenge = await (await service.fetch(post("/v1/pc/challenge", { server_id: machine.serverId, public_key: machine.publicKey }))).json() as { challenge_id: string; frame: string };
  const proof = answerServerChallenge(challenge.frame, machine.keys.secretKey, { server_id: machine.serverId, role, connection_id: challenge.challenge_id });
  const response = await service.fetch(post("/v1/pc/mailbox", { server_id: machine.serverId, challenge_id: challenge.challenge_id, proof, ack }));
  return { status: response.status, body: await response.json() as { records?: { seq: number; record: AccountRecord }[]; error?: { code: string } }, challenge, proof };
}

describe("the fake account service", () => {
  test("a record a client queues reaches each listed PC once it proves its key, and an ack clears it", async () => {
    const service = new FakeAccountService();
    const token = service.issueToken("acct_1");
    const phone = await client();
    const lost = await client();
    const [a, b] = [pc(), pc()];
    for (const machine of [a, b]) await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc" }), headers: { authorization: `Bearer ${token}` } }));
    const record = await removeRecord("acct_1", phone, lost.spki);
    expect((await service.fetch(post("/v1/records", { server_ids: [a.serverId, b.serverId], record }, token))).status).toBe(200);

    const first = await pull(service, a, null);
    expect(first.body.records?.map((entry) => entry.record)).toEqual([record]);
    const second = await pull(service, a, first.body.records![0]!.seq);
    expect(second.body.records).toEqual([]);
    expect(service.mailbox(b.serverId)).toEqual([record]);
  });

  test("a client cannot queue a forged record, another account's record, or one for a PC outside its directory", async () => {
    const service = new FakeAccountService();
    const token = service.issueToken("acct_1");
    const phone = await client();
    const machine = pc();
    await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc" }), headers: { authorization: `Bearer ${token}` } }));
    const record = await removeRecord("acct_1", phone, (await client()).spki);
    const cases: [Request, string][] = [
      [post("/v1/records", { server_ids: [machine.serverId], record: { ...record, issued_at: "2026-11-05T00:00:00.000Z" } }, token), "signature_invalid"],
      [post("/v1/records", { server_ids: [machine.serverId], record: await removeRecord("acct_2", phone, (await client()).spki) }, token), "account_mismatch"],
      [post("/v1/records", { server_ids: [pc().serverId], record }, token), "unknown_pc"],
      [post("/v1/records", { server_ids: [machine.serverId], record: { ...record, extra: true } }, token), "record_invalid"],
      [post("/v1/records", { server_ids: [machine.serverId], record }), "unauthorized"],
    ];
    for (const [request, code] of cases) expect(((await (await service.fetch(request)).json()) as { error: { code: string } }).error.code).toBe(code);
    expect(service.mailbox(machine.serverId)).toEqual([]);
  });

  test("a mailbox opens only to a proof with the account role, once per challenge", async () => {
    const service = new FakeAccountService();
    const machine = pc();
    expect((await pull(service, machine, null, "control")).status).toBe(401);
    const ok = await pull(service, machine, null);
    expect(ok.status).toBe(200);
    const replay = await service.fetch(post("/v1/pc/mailbox", { server_id: machine.serverId, challenge_id: ok.challenge.challenge_id, proof: ok.proof, ack: null }));
    expect(replay.status).toBe(401);
    const stranger = pc();
    const refused = await service.fetch(post("/v1/pc/challenge", { server_id: machine.serverId, public_key: stranger.publicKey }));
    expect(refused.status).toBe(401);
  });

  test("an answer given for the account role does not open a relay route", () => {
    const machine = pc();
    const route: ProofRoute = { server_id: machine.serverId, role: "control", connection_id: null };
    const relay = serverChallenge(machine.keys.publicKey, route);
    const accountAnswer = answerServerChallenge(relay.frame, machine.keys.secretKey, { ...route, role: "account" });
    expect(verifyServerProof(accountAnswer, relay.expected)).toBe(false);
    expect(verifyServerProof(answerServerChallenge(relay.frame, machine.keys.secretKey, route), relay.expected)).toBe(true);
  });

  test("records older than thirty days are gone", async () => {
    let now = Date.parse("2026-11-05T00:00:00.000Z");
    const service = new FakeAccountService(() => now);
    const token = service.issueToken("acct_1");
    const phone = await client();
    const machine = pc();
    await service.fetch(new Request(`${BASE}/v1/pcs/${machine.serverId}`, { method: "PUT", body: JSON.stringify({ label: "pc" }), headers: { authorization: `Bearer ${token}` } }));
    await service.fetch(post("/v1/records", { server_ids: [machine.serverId], record: await removeRecord("acct_1", phone, (await client()).spki) }, token));
    now += MAILBOX_TTL_MS + 1;
    expect((await pull(service, machine, null)).body.records).toEqual([]);
  });
});
