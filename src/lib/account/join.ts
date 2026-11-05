/**
 * Joining the account from this client (docs/account.md, "Account members", "Introductions"):
 * linking a pairing it already has, taking the introduction to the account's other PCs after a
 * remote approval, and, on the approving client, signing the new device in everywhere else. Every
 * call goes through the PC's own session (`fetch` is that PC's transport), so the PC sees which of
 * its devices is asking.
 */
import { accountDeviceId, newRecordId, signAccountRecord } from "../../../shared/account-records.ts";
import type { AddRecord, LinkRecord } from "../../../shared/account-records.ts";
import { isWssOrigin } from "../../../shared/relay-offer.ts";
import type { RelayDevice, RelayDeviceStore } from "../relay/device.ts";
import { keyIdOf } from "../relay/shellState.ts";
import type { AccountService } from "./service.ts";
import type { AccountKey } from "./store.ts";

type PcFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The PC refused an account request; `code` is its error code, never its words. */
export class AccountPcError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`The PC answered ${status} (${code})`);
    this.name = "AccountPcError";
  }
}

async function refusal(response: Response): Promise<AccountPcError> {
  let code = "http_error";
  try {
    const body = await response.json() as { error?: { code?: unknown } };
    if (typeof body.error?.code === "string" && /^[a-z_]{1,40}$/.test(body.error.code)) code = body.error.code;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return new AccountPcError(response.status, code);
}

async function post(fetch: PcFetch, path: string, body: unknown): Promise<Response> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
  if (!response.ok) throw await refusal(response);
  return response;
}

export interface PcAccountStatus {
  /** the account this PC belongs to; null before its first member */
  readonly account: string | null;
  /** its relay rows that are not members */
  readonly unlinked: readonly string[];
}

export async function pcAccountStatus(fetch: PcFetch): Promise<PcAccountStatus> {
  const response = await fetch("/api/account/status");
  if (!response.ok) throw await refusal(response);
  const body = await response.json() as { account?: unknown; unlinked?: unknown };
  const unlinked = Array.isArray(body.unlinked) ? body.unlinked.filter((id): id is string => typeof id === "string") : [];
  return { account: typeof body.account === "string" ? body.account : null, unlinked };
}

/** Whether this device's row on the PC should be linked to `account` now. */
export function needsLink(status: PcAccountStatus, device: RelayDevice, account: string): boolean {
  if (device.device_id === null) return false;
  // a PC of another account keeps this pairing as it is: the account cannot reach it
  if (status.account !== null && status.account !== account) return false;
  return status.account === null || status.unlinked.includes(device.device_id);
}

/**
 * Makes this device's row on the PC an account member: a `link` signed by the account key proves
 * both keys, and the PC swaps the row's key in one write. The device then signs in with the
 * account key there, so the saved pairing takes it too.
 */
export async function linkThisDevice(options: { fetch: PcFetch; device: RelayDevice; key: AccountKey; account: string; store: RelayDeviceStore; now?: () => number }): Promise<RelayDevice> {
  const { device, key } = options;
  if (device.device_id === null) throw new TypeError("Only a device the PC admitted can be linked");
  const record: LinkRecord = await signAccountRecord({
    v: 1, kind: "link", account: options.account, key: key.public_spki, server_id: device.server_id, device_id: device.device_id,
    old_key: device.public_spki, issued_at: new Date((options.now ?? Date.now)()).toISOString(), id: newRecordId(), signer: key.public_spki,
  }, key.private_key);
  await post(options.fetch, "/api/account/link", { record });
  return options.store.update(device.server_id, (current) => {
    if (current === undefined) throw new TypeError("This PC was forgotten meanwhile");
    return { ...current, private_key: key.private_key, public_spki: key.public_spki };
  });
}

export interface IntroducedPc { readonly server_id: string; readonly server_public_key: string; readonly relay: string; readonly name: string }

/** Only an introduction whose id is its key's (server/relay/identity.ts) and whose relay is a wss origin. */
function parseIntroduced(value: unknown): IntroducedPc | null {
  if (typeof value !== "object" || value === null) return null;
  const pc = value as Record<string, unknown>;
  if (typeof pc.server_id !== "string" || typeof pc.server_public_key !== "string" || typeof pc.relay !== "string" || typeof pc.name !== "string") return null;
  if (keyIdOf(pc.server_public_key) !== pc.server_id || !isWssOrigin(pc.relay) || pc.name.length > 48) return null;
  return { server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay, name: pc.name };
}

/**
 * After a remote approval on PC X: the account's other PCs as the approver checked them, saved so
 * this device signs in to each with the account key and the id the `add` gave it there. A PC this
 * device already has is left as it is. Returns the PCs saved.
 */
export async function takeIntroduction(options: { fetch: PcFetch; key: AccountKey; label: string; store: RelayDeviceStore }): Promise<RelayDevice[]> {
  const response = await options.fetch("/api/account/introduction");
  if (response.status === 404) return [];
  if (!response.ok) throw await refusal(response);
  const body = await response.json() as { pcs?: unknown };
  const pcs = (Array.isArray(body.pcs) ? body.pcs : []).map(parseIntroduced).filter((pc): pc is IntroducedPc => pc !== null);
  const saved: RelayDevice[] = [];
  for (const pc of pcs) {
    if (await options.store.get(pc.server_id) !== undefined) continue;
    saved.push(await options.store.update(pc.server_id, (current) => current ?? {
      server_id: pc.server_id, server_public_key: pc.server_public_key, relay: pc.relay, name: pc.name,
      device_id: accountDeviceId(pc.server_id, options.key.public_spki), private_key: options.key.private_key, public_spki: options.key.public_spki, label: options.label,
    }));
  }
  return saved;
}

/**
 * On the approving client, once PC X let the new device in: an `add` for its key, put in the
 * mailbox of every other PC of the account, and an introduction to the PCs this client checked
 * itself, handed to X for the new device to collect.
 */
export async function admitToAccount(options: {
  fetch: PcFetch; service: AccountService; key: AccountKey; account: string;
  joining: { key: string; label: string }; through: string; paired: readonly RelayDevice[]; directory: readonly string[]; now?: () => number;
}): Promise<AddRecord> {
  const add: AddRecord = await signAccountRecord({
    v: 1, kind: "add", account: options.account, key: options.joining.key, label: options.joining.label, role: "drive",
    issued_at: new Date((options.now ?? Date.now)()).toISOString(), id: newRecordId(), signer: options.key.public_spki,
  }, options.key.private_key);
  const others = options.directory.filter((serverId) => serverId !== options.through);
  for (let start = 0; start < others.length; start += 32) await options.service.postRecord(others.slice(start, start + 32), add);
  const pcs = options.paired
    .filter((device) => device.device_id !== null && device.server_id !== options.through && keyIdOf(device.server_public_key) === device.server_id)
    .slice(0, 32)
    .map((device) => ({ server_id: device.server_id, server_public_key: device.server_public_key, relay: device.relay, name: (device.name ?? device.server_id.slice(0, 8)).slice(0, 48) }));
  await post(options.fetch, "/api/account/introduce", { key: options.joining.key, pcs });
  return add;
}
