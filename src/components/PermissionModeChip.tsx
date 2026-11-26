import { useState } from "react";
import { ShieldCheck } from "lucide-react";

import "./PermissionModeChip.css";

import type { ClaudePermissionMode } from "../../shared/protocol.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { useT, type Translate } from "../lib/i18n.ts";

/** the badge's words, one key per mode so each is translated whole */
export function permissionModeLabel(t: Translate, mode: ClaudePermissionMode): string {
  switch (mode) {
    case "acceptEdits": return t("Mode: accept edits");
    case "plan": return t("Mode: plan");
    case "auto": return t("Mode: auto");
    case "bypassPermissions": return t("Mode: bypass permissions");
    default: return t("Mode: default");
  }
}

/**
 * A Claude pane's permission mode in the composer's status row, with a button that presses Shift+Tab
 * in the pane to cycle it (Claude Code's own key). The mode is read off the pane's footer by each prompt
 * read, so a change made in the terminal shows within a couple of seconds as well.
 */
export function PermissionModeChip({ paneId, mode, disabled }: { paneId: string; mode: ClaudePermissionMode; disabled: boolean }) {
  const t = useT();
  const { sendPaneKeys } = useMachineApi();
  const [pressing, setPressing] = useState(false);
  const label = permissionModeLabel(t, mode);
  const cycle = t("Cycle mode (Shift+Tab)");
  return <span className={`permission-mode is-${mode}`}>
    <span className="permission-mode-label">{label}</span>
    <button type="button" className="permission-mode-cycle" aria-label={cycle} title={cycle} disabled={disabled || pressing}
      onPointerDown={(event) => event.preventDefault()}
      onClick={() => {
        setPressing(true);
        void sendPaneKeys(paneId, ["shift+tab"]).catch(() => undefined).finally(() => setPressing(false));
      }}>
      <ShieldCheck aria-hidden="true" />
    </button>
  </span>;
}
