/**
 * Leaving the account from this device (docs/account.md, rule 5; design "sign out"): a `remove`
 * for its own account key, signed by that key, goes to the mailbox of every PC of the account, so
 * each PC revokes this device the next time it collects its mail; then the sign-in ends and this
 * device forgets its account key and the pairings that used it. Signing out only ends the sign-in
 * and keeps every pairing, as one made by QR code is kept.
 */
import { newRecordId, signAccountRecord } from "../../../shared/account-records.ts";
import type { RemoveRecord } from "../../../shared/account-records.ts";
import type { RelayDeviceStore } from "../relay/device.ts";
import type { AccountService } from "./service.ts";
import type { AccountStore } from "./store.ts";
import { post, type PcFetch } from "./join.ts";

export async function leaveAccount(options: { service: AccountService; accountStore: AccountStore; relayStore: RelayDeviceStore; now?: () => number }): Promise<RemoveRecord> {
  const session = await options.service.session();
  if (session === undefined) throw new Error("Sign in first, so every PC of the account hears of it");
  const key = await options.accountStore.key();
  const remove: RemoveRecord = await signAccountRecord({
    v: 1, kind: "remove", account: session.account, key: key.public_spki,
    issued_at: new Date((options.now ?? Date.now)()).toISOString(), id: newRecordId(), signer: key.public_spki,
  }, key.private_key);
  const pcs = (await options.service.listPcs()).map((pc) => pc.server_id);
  for (let start = 0; start < pcs.length; start += 32) await options.service.postRecord(pcs.slice(start, start + 32), remove);
  await options.service.signOut();
  for (const device of await options.relayStore.list()) {
    if (device.public_spki === key.public_spki) await options.relayStore.remove(device.server_id);
  }
  await options.accountStore.clear();
  return remove;
}

/**
 * Disconnects another device of the account from every PC of it (a lost phone): a `remove` for
 * its account key, signed by this device's, applied at once on the PC this window is in (`here`)
 * and left in the mailbox of every PC of the account for the others to apply when they collect it.
 */
export async function removeFromAccount(options: { service: AccountService; accountStore: AccountStore; key: string; here?: PcFetch; now?: () => number }): Promise<RemoveRecord> {
  const session = await options.service.session();
  if (session === undefined) throw new Error("Sign in first, so every PC of the account hears of it");
  const own = await options.accountStore.key();
  if (options.key === own.public_spki) throw new TypeError("This device leaves the account with leaveAccount");
  const remove: RemoveRecord = await signAccountRecord({
    v: 1, kind: "remove", account: session.account, key: options.key,
    issued_at: new Date((options.now ?? Date.now)()).toISOString(), id: newRecordId(), signer: own.public_spki,
  }, own.private_key);
  if (options.here) await post(options.here, "/api/account/records", { records: [remove] });
  const pcs = (await options.service.listPcs()).map((pc) => pc.server_id);
  for (let start = 0; start < pcs.length; start += 32) await options.service.postRecord(pcs.slice(start, start + 32), remove);
  return remove;
}
