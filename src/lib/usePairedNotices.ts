import { useCallback, useState } from "react";
import type { DevicePairedEvent, RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";

/** Enrollments this window was told of and has not dismissed (components/DevicePairedNotice.tsx), and relay pairings waiting for approval (components/RelayPairingPrompt.tsx). */
export function usePairedNotices() {
  const [pairedNotices, setPairedNotices] = useState<readonly DevicePairedEvent[]>([]);
  const [relayPairings, setRelayPairings] = useState<readonly RelayPairingRequest[]>([]);
  /** devices asking to join the account through this PC, for this device to approve as a member (components/AccountApprovals.tsx) */
  const [remotePairings, setRemotePairings] = useState<readonly RemotePairingRequest[]>([]);
  const dismissPairedNotice = useCallback((event: DevicePairedEvent) => setPairedNotices((list) => list.filter((item) => item.event_id !== event.event_id)), []);
  return { pairedNotices, setPairedNotices, dismissPairedNotice, relayPairings, setRelayPairings, remotePairings, setRemotePairings };
}
