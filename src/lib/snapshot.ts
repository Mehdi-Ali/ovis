import type { AgentStatus, HerdrPane, PaneCache, PaneContext, PlanSummary, SessionSnapshot } from "../../shared/protocol.ts";

const samePlan = (a: PlanSummary | undefined, b: PlanSummary | undefined): boolean =>
  a === b || (a !== undefined && b !== undefined && a.done === b.done && a.total === b.total && a.current === b.current);

/**
 * Merges a pushed `pane-status` into the last snapshot so the sidebar badge updates
 * instantly; the debounced /api/session refetch that follows brings the derived
 * workspace/tab rollups back in line. Pure: returns the same object when nothing changed.
 */
export function applyPaneStatus(snapshot: SessionSnapshot, paneId: string, status: AgentStatus, background?: number, waiting = false, plan?: PlanSummary | null, finishId?: number, finishEpoch?: string, context?: PaneContext | null, cache?: PaneCache | null): SessionSnapshot {
  const epochChanged = snapshot.finish_epoch !== finishEpoch;
  let paneChanged = epochChanged;
  const panes = snapshot.panes.map((pane: HerdrPane) => {
    if (pane.pane_id !== paneId) {
      if (!epochChanged) return pane;
      const { finish_id: _finish, ...rest } = pane;
      return rest;
    }
    const tasks = background === undefined ? pane.background_tasks : background > 0 ? background : undefined;
    const progress = plan === undefined ? pane.plan : plan ?? undefined;
    const filled = context === undefined ? pane.context : context ?? undefined;
    const written = cache === undefined ? pane.cache : cache ?? undefined;
    if (pane.agent_status === status && pane.finish_id === finishId && pane.background_tasks === tasks && (pane.background_wait === true) === waiting && samePlan(pane.plan, progress) && pane.context?.used === filled?.used && pane.context?.window === filled?.window && pane.cache?.last_at === written?.last_at && pane.cache?.ttl_ms === written?.ttl_ms) return pane;
    paneChanged = true;
    const { background_tasks: _before, background_wait: _waited, plan: _plan, context: _context, cache: _cache, finish_id: _finish, ...rest } = pane;
    return { ...rest, agent_status: status, ...(finishId === undefined ? {} : { finish_id: finishId }), ...(tasks === undefined ? {} : { background_tasks: tasks }), ...(waiting ? { background_wait: true as const } : {}), ...(progress === undefined ? {} : { plan: progress }), ...(filled === undefined ? {} : { context: filled }), ...(written === undefined ? {} : { cache: written }) };
  });
  if (!paneChanged) return snapshot;
  const agents = snapshot.agents.map((agent) =>
    agent.pane_id === paneId && agent.agent_status !== status ? { ...agent, agent_status: status } : agent,
  );
  return { ...snapshot, finish_epoch: finishEpoch, panes, agents };
}
