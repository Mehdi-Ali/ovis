import { useMemo } from "react";

import type { SessionSnapshot, WorkspaceInfo } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { agentContext, agentTabName, paneMark, sidebarAgents } from "../lib/sidebarAgents.ts";
import { useSidebarActivity } from "../lib/sidebarActivity.tsx";
import { PANE_DRAG_TYPE, paneDragData } from "../lib/split.ts";
import { hasAgentMark } from "./AgentMark.tsx";
import { AgentRowBody } from "./AgentSidebar.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import "./AgentSidebar.css";

interface NestedAgentsProps {
  snapshot: SessionSnapshot | null;
  workspace: WorkspaceInfo;
  machineId: string;
  online: boolean;
  selectedPaneId: string | null;
  onSelect(paneId: string): void;
}

/**
 * local: a workspace's live agents, nested under its row. Replaces the separate Agents list, so the
 * sidebar is one tree: PC, workspace, agents. The row says what the agent works on, and its tab
 * when the workspace has more than one; the workspace is the row above, so it is not repeated.
 */
export function NestedAgents({ snapshot, workspace, machineId, online, selectedPaneId, onSelect }: NestedAgentsProps) {
  const t = useT();
  const activity = useSidebarActivity();
  const agents = useMemo(() => sidebarAgents(snapshot).filter((entry) => entry.workspace.workspace_id === workspace.workspace_id), [snapshot, workspace.workspace_id]);
  if (agents.length === 0) return null;
  const tabs = snapshot?.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id) ?? [];
  return <ul className="agent-list nested-agents" aria-label={t("Agents in {name}", { name: workspace.label })}>
    {agents.map((entry) => {
      const { pane, tab, agent, agentLabel } = entry;
      const selected = pane.pane_id === selectedPaneId;
      const title = pane.label?.trim() || agent?.title?.trim() || pane.title?.trim() || displayPaneTitle(pane);
      const name = agent?.name?.trim() || null;
      const kindLabel = name !== null && agentLabel === name ? entry.canonicalAgent ?? agent?.title?.trim() ?? null : agentLabel;
      const mark = paneMark(entry);
      const markAgent = mark && hasAgentMark(mark) ? mark : null;
      const contextParts = agentContext({ agentLabel: kindLabel, title, markAgent, machineName: null, workspaceLabel: "", tabName: agentTabName(tab, tabs, t) });
      const context = contextParts.join(" · ");
      const kind = kindLabel?.trim() || null;
      const markKind = kind && kind !== title.trim() && !contextParts.includes(kind) ? kind : null;
      const tooltip = [...new Set([pane.pane_id, title, context, markKind, name, pane.cwd].filter(Boolean))].join("\n");
      return <li key={pane.pane_id} className={`agent-item nested-agent${selected ? " is-selected" : ""}${online ? "" : " is-offline"}`} data-machine={machineId} data-pane={pane.pane_id}>
        <button type="button" className="agent-select agent-row" disabled={!online} aria-current={selected ? "true" : undefined} title={tooltip}
          onClick={() => onSelect(pane.pane_id)}
          draggable={online}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData(PANE_DRAG_TYPE, paneDragData({ machineId, paneId: pane.pane_id }));
          }}>
          <AgentRowBody mark={mark} markKind={markKind} title={title} name={name} context={context}
            backgroundTasks={online ? pane.background_tasks : 0} plan={online ? pane.plan : undefined} status={online ? activity.status(machineId, pane) : undefined} />
        </button>
      </li>;
    })}
  </ul>;
}
