/**
 * My PCs: the account's directory, which this client does not trust, merged with the PCs this
 * client is paired with, which it does. A PC in the directory alone still needs this device
 * approved; its name there is only a label, and its key comes from comparing digits, never from
 * the directory (docs/account.md, rule 6).
 */
import type { RelayDevice } from "../relay/device.ts";
import type { DirectoryPc } from "./service.ts";

/** The PC pulls its mailbox every five minutes while it belongs to the account; three missed pulls and it is called off. */
export const OFFLINE_AFTER_MS = 15 * 60_000;

export type MyPcState = "paired" | "needs-approval" | "offline" | "needs-update";

export interface MyPc {
  readonly server_id: string;
  readonly name: string;
  readonly state: MyPcState;
  /** when the PC last came by the account service; null when it never has */
  readonly last_seen_at: string | null;
  /** in the account's directory; false for a PC paired by QR code that the account does not list yet */
  readonly listed: boolean;
  /** this device holds an admitted key for it, so it can open; whatever its state says */
  readonly paired: boolean;
}

const ORDER: Record<MyPcState, number> = { paired: 0, "needs-update": 1, "needs-approval": 2, offline: 3 };

/**
 * One row per PC. `outdated`: PCs whose last connection showed an Ovis without accounts. A paired
 * PC is offline only once the directory has seen it and not lately: one that never pulled may just
 * not belong to the account yet.
 */
export function myPcs(directory: readonly DirectoryPc[], paired: readonly RelayDevice[], options: { now: number; outdated?: ReadonlySet<string> }): MyPc[] {
  const listed = new Map(directory.map((pc) => [pc.server_id, pc]));
  const rows: MyPc[] = [];
  const stateOf = (serverId: string, isPaired: boolean, lastSeen: string | null): MyPcState => {
    if (options.outdated?.has(serverId)) return "needs-update";
    if (lastSeen !== null && options.now - Date.parse(lastSeen) > OFFLINE_AFTER_MS) return "offline";
    return isPaired ? "paired" : "needs-approval";
  };
  for (const device of paired) {
    if (device.device_id === null) continue;
    const entry = listed.get(device.server_id);
    listed.delete(device.server_id);
    const lastSeen = entry?.last_seen_at ?? null;
    rows.push({ server_id: device.server_id, name: device.name ?? entry?.label ?? device.server_id.slice(0, 8), state: stateOf(device.server_id, true, lastSeen), last_seen_at: lastSeen, listed: entry !== undefined, paired: true });
  }
  for (const pc of listed.values()) {
    rows.push({ server_id: pc.server_id, name: pc.label, state: stateOf(pc.server_id, false, pc.last_seen_at), last_seen_at: pc.last_seen_at, listed: true, paired: false });
  }
  return rows.sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name));
}
