import "./AccountPcs.css";

import { ChevronRight } from "lucide-react";

import type { MyPc } from "../lib/account/myPcs.ts";
import type { AccountProvider } from "../lib/account/store.ts";
import { useT } from "../lib/i18n.ts";
import { lastSeen } from "../lib/lastSeen.ts";
import type { AccountView } from "../lib/relay/shellState.ts";
import { serverScopePath } from "../lib/shellMode.ts";

const PROVIDER_NAMES: Record<AccountProvider, string> = { github: "GitHub", apple: "Apple" };

/**
 * Sign in with GitHub or Apple, side by side and alike: App Review 4.8 asks for Sign in with Apple
 * wherever another provider is offered, and neither is the "right" one to pick.
 */
export function AccountSignIn({ onSignIn, error }: { onSignIn: (provider: AccountProvider) => void; error: string | null }) {
  const t = useT();
  return (
    <div className="account-sign-in">
      <div className="relay-shell-actions">
        <button type="button" className="btn" onClick={() => onSignIn("github")}>{t("Continue with GitHub")}</button>
        <button type="button" className="btn" onClick={() => onSignIn("apple")}>{t("Continue with Apple")}</button>
      </div>
      {error !== null && <p className="relay-shell-detail" role="alert">{error}</p>}
      <p className="relay-shell-detail">{t("The account service knows only your PCs' names and IDs. Terminals and chats travel encrypted between this device and your PCs.")}</p>
    </div>
  );
}

function stateText(pc: MyPc, t: ReturnType<typeof useT>): string {
  switch (pc.state) {
    case "paired": return t("Paired");
    case "needs-approval": return t("This device is not approved on it yet");
    case "offline": return t("Offline, last seen {when}", { when: lastSeen(pc.last_seen_at) });
    case "needs-update": return t("Its Ovis needs an update to join the account");
  }
}

/** The account's PCs: a paired one opens; the others say what they wait for. */
export function AccountPcList({ pcs }: { pcs: readonly MyPc[] }) {
  const t = useT();
  return (
    <ul className="relay-shell-pcs">
      {pcs.map((pc) => {
        const body = (
          <span className="account-pc-text">
            <span className="relay-shell-pc-name">{pc.name}</span>
            <span className="account-pc-state">{stateText(pc, t)}</span>
          </span>
        );
        return (
          <li key={pc.server_id} data-pc-state={pc.state}>
            {pc.paired
              ? <a className="relay-shell-pc" href={serverScopePath(pc.server_id)}>{body}<ChevronRight className="relay-shell-pc-glyph" aria-hidden="true" /></a>
              : <div className="relay-shell-pc account-pc-waiting">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** The front page once signed in: the account's PCs, then how another one joins. */
export function AccountPcs({ view }: { view: Extract<AccountView, { kind: "signed-in" }> }) {
  const t = useT();
  return (
    <>
      <h1 className="relay-shell-title">{t("Your PCs")}</h1>
      <p className="relay-shell-copy">{t("Signed in with {provider}", { provider: PROVIDER_NAMES[view.provider] })}</p>
      {view.pcs === null
        ? <div className="relay-shell-wait" role="status"><div className="boot-spinner" aria-hidden="true" /><span className="visually-hidden">{t("Loading your PCs…")}</span></div>
        : <AccountPcList pcs={view.pcs} />}
      {view.error !== null && <p className="relay-shell-detail" role="alert">{view.error}</p>}
      <p className="relay-shell-copy">{t("To add a PC, sign in to this account on it, or scan the QR code it shows under Phone & devices.")}</p>
    </>
  );
}
