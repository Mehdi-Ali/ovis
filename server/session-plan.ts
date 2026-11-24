import { cacheTtlMs } from "../shared/claude-cache.ts";
import type { ConversationMetadata, HerdrPane, PaneCache, PaneContext, PlanStep, PlanSummary } from "../shared/protocol.ts";
import { plain } from "./claude-subagents.ts";
import { PLAN_BUDGET, planState, readPlan, type PlanSource } from "./session-plan-reader.ts";
export { forgetPlans, readPlan, type PlanSource } from "./session-plan-reader.ts";

export function planSummary(steps: readonly PlanStep[] | null): PlanSummary | null {
  if (steps === null || steps.length === 0) return null;
  const current = steps.find((step) => step.status === "in_progress");
  return { done: steps.filter((step) => step.status === "completed").length, total: steps.length, current: current ? current.active ?? current.label : null };
}

export interface SessionPlanDeps {
  claudePath: (paneId: string) => string | null;
  omoPath?: (paneId: string) => string | null;
  codexPath: (pane: HerdrPane) => Promise<string | null>;
  onChange: (paneId: string, summary: PlanSummary | null) => void;
  onContext?: (paneId: string, context: PaneContext | null) => void;
  /** a Claude pane's prompt cache mark changed (null: none now), for the sidebar's cache time */
  onCache?: (paneId: string, cache: PaneCache | null) => void;
  /** a Claude session's window as its status line capture names it (server/statusline.ts), as the chat's ring takes it; null when none does */
  claudeWindow?: (transcriptPath: string, model: string | null) => number | null;
  now?: () => number;
  retryMs?: number;
  relocateMs?: number;
  pollMs?: number;
}

interface Tracked {
  key: string;
  at: number;
  where: { source: PlanSource; path: string } | null;
  sig: string | null;
  summary: PlanSummary | null;
  metadata: ConversationMetadata | null;
  context: PaneContext | null;
  /** the cache mark last told */
  cache: PaneCache | null;
}

export class SessionPlans {
  private readonly panes = new Map<string, Tracked>();
  private readonly wanted = new Map<string, string>();
  private refreshed = false;
  private readonly looking = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: SessionPlanDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.poll(), this.deps.pollMs ?? 2000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  summaryOf(paneId: string): PlanSummary | null {
    return this.panes.get(paneId)?.summary ?? null;
  }

  contextOf(paneId: string): PaneContext | null {
    return this.panes.get(paneId)?.context ?? null;
  }

  /** When the pane's prompt cache was last written, as the poll last told it. */
  cacheOf(paneId: string): PaneCache | null {
    return this.panes.get(paneId)?.cache ?? null;
  }

  /**
   * The plan of the pane as herdr has it now (undefined: herdr did not say), as the poll last read it: null when it has
   * none, or its transcript is not known for the session it runs, or not read to its end yet.
   */
  planOf(pane: HerdrPane | undefined): PlanStep[] | null {
    const where = pane !== undefined && this.known(pane) ? this.panes.get(pane.pane_id)?.where : null;
    return where ? readPlan(where.source, where.path, { left: 0 }) : null;
  }

  known(pane: HerdrPane): boolean {
    const tracked = this.panes.get(pane.pane_id);
    return tracked?.where != null && tracked.key === keyOf(pane);
  }

  async refresh(panes: HerdrPane[]): Promise<void> {
    this.wanted.clear();
    this.refreshed = true;
    for (const pane of panes) if (pane.agent === "claude" || pane.agent === "codex" || pane.agent === "omo") this.wanted.set(pane.pane_id, keyOf(pane));
    for (const [paneId, tracked] of this.panes) {
      if (this.wanted.has(paneId)) continue;
      this.panes.delete(paneId);
      if (tracked.summary !== null) this.deps.onChange(paneId, null);
      if (tracked.context !== null) this.deps.onContext?.(paneId, null);
      if (tracked.cache !== null) this.deps.onCache?.(paneId, null);
    }
    await Promise.all(panes.map((pane) => this.ensure(pane)));
  }

  async ensure(pane: HerdrPane, asked = false): Promise<void> {
    if (pane.agent !== "claude" && pane.agent !== "codex" && pane.agent !== "omo") return;
    const key = keyOf(pane);
    if (pane.agent === "omo") {
      const path = this.deps.omoPath?.(pane.pane_id) ?? null;
      this.track(pane.pane_id, key, path === null ? null : { source: "omo-session", path });
      return;
    }
    if (pane.agent === "claude") {
      const path = this.deps.claudePath(pane.pane_id);
      this.track(pane.pane_id, key, path === null ? null : { source: "claude-transcript", path });
      return;
    }
    const tracked = this.panes.get(pane.pane_id);
    const due = !tracked || tracked.key !== key || this.now() - tracked.at >= (tracked.where === null ? this.deps.retryMs ?? 15_000 : this.deps.relocateMs ?? 30_000);
    if (!due || this.looking.has(pane.pane_id)) return;
    this.looking.add(pane.pane_id);
    try {
      const path = await this.deps.codexPath(pane).catch(() => null);
      if (!asked && this.refreshed && this.wanted.get(pane.pane_id) !== key) return;
      this.track(pane.pane_id, key, path === null ? null : { source: "codex-transcript", path });
    } finally {
      this.looking.delete(pane.pane_id);
    }
  }

  private track(paneId: string, key: string, where: { source: PlanSource; path: string } | null): void {
    const current = this.panes.get(paneId);
    const same = current !== undefined && current.where?.path === where?.path && current.where?.source === where?.source;
    const sameSession = same && current.key === key;
    this.panes.set(paneId, { key, at: this.now(), where, sig: sameSession ? current.sig : null, summary: current?.summary ?? null, metadata: sameSession ? current.metadata : null, context: current?.key === key ? current.context : null, cache: current?.key === key ? current.cache : null });
    if (current !== undefined && current.key !== key && current.context !== null) this.deps.onContext?.(paneId, null);
    if (current !== undefined && current.key !== key && current.cache !== null) this.deps.onCache?.(paneId, null);
  }

  poll(): void {
    const budget = { left: PLAN_BUDGET };
    for (const [paneId, tracked] of this.panes) {
      if (tracked.where === null) {
        tracked.metadata = null;
        this.tellSummary(paneId, tracked, null);
      } else {
        const stat = plain(tracked.where.path);
        const sig = stat === null ? null : `${stat.id}:${stat.size}`;
        if (sig === null || sig !== tracked.sig) {
          const read = planState(tracked.where.source, tracked.where.path, budget);
          if (!read.behind) tracked.sig = sig;
          if (read.steps !== null || !read.behind) {
            tracked.metadata = read.metadata;
            this.tellSummary(paneId, tracked, planSummary(read.steps));
          }
        }
      }
      this.tellContext(paneId, tracked);
      this.tellCache(paneId, tracked);
    }
  }

  private tellSummary(paneId: string, tracked: Tracked, summary: PlanSummary | null): void {
    if (JSON.stringify(summary) === JSON.stringify(tracked.summary)) return;
    tracked.summary = summary;
    this.deps.onChange(paneId, summary);
  }

  private tellContext(paneId: string, tracked: Tracked): void {
    const read = tracked.metadata?.context ?? null;
    const window = read !== null && tracked.where?.source === "claude-transcript" ? this.deps.claudeWindow?.(tracked.where.path, tracked.metadata?.model ?? null) ?? null : null;
    const context = read === null ? null : window === null ? read : { ...read, window };
    if (JSON.stringify(context) === JSON.stringify(tracked.context)) return;
    tracked.context = context;
    this.deps.onContext?.(paneId, context);
  }

  /** The main session's cache: its latest write's time and lifetime, a Claude transcript's only; none before an answer reported usage. */
  private tellCache(paneId: string, tracked: Tracked): void {
    const main = tracked.where?.source === "claude-transcript" ? tracked.metadata?.cache?.main : undefined;
    const cache = main === undefined || main.last_at === null ? null : { last_at: main.last_at, ttl_ms: cacheTtlMs(main, true) };
    if (JSON.stringify(cache) === JSON.stringify(tracked.cache)) return;
    tracked.cache = cache;
    this.deps.onCache?.(paneId, cache);
  }
}

const keyOf = (pane: HerdrPane): string => `${pane.agent}\0${pane.agent_session?.value ?? ""}\0${pane.cwd ?? ""}`;
