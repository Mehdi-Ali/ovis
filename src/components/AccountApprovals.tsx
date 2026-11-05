/**
 * Devices asking to join the account through the PC this window is in (`remote-pairings`): the
 * first waits in AccountApprovalPrompt. An approval tells this PC first, which lets the device in
 * here; then this device signs the `add` for the account's other PCs and leaves the PCs it checked
 * itself with this PC as the new device's introduction (lib/account/join.ts).
 */
import { useEffect, useState } from "react";

import type { RemotePairingRequest } from "../../shared/protocol.ts";
import { admitToAccount } from "../lib/account/join.ts";
import { accountServiceOf, AccountService } from "../lib/account/service.ts";
import { indexedAccountStore } from "../lib/account/store.ts";
import { decideRelayPairing } from "../lib/api.ts";
import { indexedDeviceStore } from "../lib/relay/device.ts";
import { serverIdOfPath } from "../lib/shellMode.ts";
import { getTransport } from "../lib/transport.ts";
import { AccountApprovalPrompt } from "./AccountApprovalPrompt.tsx";

/** The new device's key, once the PC names it (docs/account.md, "Who may admit a device"). */
function joiningKey(request: RemotePairingRequest): string | null {
  const key = (request as RemotePairingRequest & { key?: unknown }).key;
  return typeof key === "string" ? key : null;
}

export function AccountApprovals({ pairings }: { pairings: readonly RemotePairingRequest[] }) {
  const request = pairings[0];
  const serverId = serverIdOfPath(window.location.pathname);
  const [where, setWhere] = useState<{ pcName: string; pcCount: number }>({ pcName: "", pcCount: 1 });

  useEffect(() => {
    if (serverId === null) return;
    let live = true;
    void (async () => {
      const paired = await indexedDeviceStore.list();
      const here = paired.find((device) => device.server_id === serverId);
      const service = accountServiceOf(document);
      let count = paired.filter((device) => device.device_id !== null).length;
      if (service !== null) {
        try { count = Math.max(count, (await new AccountService({ store: indexedAccountStore }).listPcs()).length); }
        catch (error) { console.warn("Ovis: the account's PCs could not be counted", error instanceof Error ? error.name : error); }
      }
      if (live) setWhere({ pcName: here?.name ?? serverId.slice(0, 8), pcCount: Math.max(count, 1) });
    })();
    return () => { live = false; };
  }, [serverId]);

  if (request === undefined || serverId === null) return null;

  const decide = async (decision: "approve" | "decline", digits?: string): Promise<void> => {
    await decideRelayPairing(request.id, decision, digits);
    const key = joiningKey(request);
    if (decision !== "approve" || key === null) return;
    const service = new AccountService({ store: indexedAccountStore });
    const session = await service.session();
    if (session === undefined) return;
    const transport = getTransport();
    await admitToAccount({
      fetch: (path, init) => transport.fetch(path, init), service, key: await indexedAccountStore.key(), account: session.account,
      joining: { key, label: request.label }, through: serverId, paired: await indexedDeviceStore.list(),
      directory: (await service.listPcs()).map((pc) => pc.server_id),
    });
  };

  return <AccountApprovalPrompt key={request.id} request={request} pcName={where.pcName} pcCount={where.pcCount} onDecide={decide} />;
}
