import { useEffect, useState } from "react";
import { indexedAccountStore } from "./store.ts";

/** Whether this browser is signed in to the account: the account's actions show only then. */
export function useAccountSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let live = true;
    indexedAccountStore.get("session").then((session) => { if (live) setSignedIn(session !== undefined); }, () => undefined);
    return () => { live = false; };
  }, []);
  return signedIn;
}
