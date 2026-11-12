/**
 * The phone's agent inbox (components/AgentInbox.tsx): every shown PC's agents in one list, the ones
 * that need the reader first, narrowed by state. Built on the Agents list's own rows and shown state
 * (lib/agentRoster.ts, lib/sidebarActivity.tsx), so the two never disagree.
 */
import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, ConversationTurn, PlanSummary } from "../../shared/protocol.ts";
import { agentGroup, agentRoster, groupAgentRows, type AgentGroup, type AgentRow } from "./agentRoster.ts";
import { fileFromLink, type AppLink } from "./deepLink.ts";
import type { Translate } from "./i18n.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";
import { capped } from "./promptText.ts";
import { machineFilter, sidebarFilter } from "./sidebarFilter.ts";
import { sidebarPinKey } from "./sidebarPins.ts";

/** All, then the three states that ask for a look or say work goes on; a resting agent shows only under All. */
export const INBOX_FILTERS = ["all", "blocked", "working", "done"] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];

/** A row is its PC and its pane: two PCs may reuse a pane id. */
export function inboxKey(row: AgentRow): string {
  return sidebarPinKey(row.machine.id, row.entry.pane.pane_id);
}

/** The state a row draws, as the Agents list draws it; a PC that is away says none. */
export function inboxStatus(row: AgentRow, activity: SidebarActivity): AgentStatus | undefined {
  return row.machine.state === "connected" ? activity.status(row.machine.id, row.entry.pane) : undefined;
}

/** Every agent row: needs you, working, done, resting; within a state each PC's most recently changed first. */
export function inboxOrder(machines: readonly Machine[], activity: SidebarActivity): AgentRow[] {
  const rows = agentRoster(machines, { byActivity: false, seqs: activity.seqs, pinned: [] }).rest;
  return groupAgentRows(rows, { sort: "recent", status: (row) => inboxStatus(row, activity), name: () => "", seqs: activity.seqs })
    .flatMap((group) => group.rows);
}

/** The rows a filter keeps, by each row's own state. */
export function inboxFiltered(rows: readonly AgentRow[], filter: InboxFilter, activity: SidebarActivity): AgentRow[] {
  return filter === "all" ? [...rows] : rows.filter((row) => agentGroup(inboxStatus(row, activity)) === filter);
}

/** The rows a typed query keeps, matched on the labels the Agents list shows (lib/sidebarFilter.ts); a blank query keeps all. */
export function inboxSearched(rows: readonly AgentRow[], query: string, machines: readonly Machine[], t: Translate): AgentRow[] {
  const filter = sidebarFilter(query, machines, { machineId: "", paneId: null }, t);
  return rows.filter((row) => !filter.active || machineFilter(filter, row.machine.id)?.panes.has(row.entry.pane.pane_id) === true);
}

/** The rows in the order `held` names their keys, the rest after them in their given order. */
export function heldOrder<T>(rows: readonly T[], keyOf: (row: T) => string, held: readonly string[]): T[] {
  const place = new Map(held.map((key, index) => [key, index]));
  const rank = (row: T): number => place.get(keyOf(row)) ?? held.length;
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

/** Why the list draws no row: a roster still on its way, no agent at all, or a filter or query that leaves none. */
export function inboxEmpty(machines: readonly Machine[], total: number, shown: number): "loading" | "none" | "no-match" | null {
  if (total === 0) return machines.length === 0 || machines.some((machine) => machine.state === "connected" && machine.snapshot === null) ? "loading" : "none";
  return shown === 0 ? "no-match" : null;
}

/** What a waiting agent asks, for its row: the question, then the first line of what it is about. */
export function questionWords(words: { question: string; body: string | null }): string {
  const first = words.body?.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
  return capped([words.question.trim(), first].filter((part) => part !== "").join("\n"), 240);
}

/** The agent's own words for its row, by its state; never words borrowed from another state. */
export function inboxWords(input: { group: AgentGroup; blocked: string | null; question: string | null; plan: PlanSummary | undefined; last: string | null }): string | null {
  if (input.group === "blocked") return input.blocked ?? input.question ?? input.last;
  if (input.group === "working") return input.plan?.current?.trim() || input.last;
  return input.last;
}

/** Whether a phone opens on the list: the address names no pane, workspace or file. */
export function inboxStartsOpen(enabled: boolean, link: AppLink | null): boolean {
  return enabled && !(link !== null && Boolean(link.pane || link.workspace || fileFromLink(link)));
}

// The look preview's reader (components/AgentInbox.tsx); removed when the screen todo stops using it.
/**
 * The newest turn's words and when it ended: the agent's final answer, else its last text, or the
 * user's own message while nothing answered it yet. Null when no turn holds text.
 */
export function lastWords(turns: readonly ConversationTurn[]): { role: "assistant" | "user"; text: string; at: string | null } | null {
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!;
    const texts = turn.parts.flatMap((part) => part.kind === "text" && part.text.trim() !== "" ? [part] : []);
    if (texts.length === 0) continue;
    const picked = turn.role === "assistant" ? [...texts].reverse().find((part) => part.phase === "final_answer") ?? texts.at(-1)! : texts[0]!;
    return { role: turn.role, text: capped(picked.text.replace(/\s+/g, " ").trim(), 280), at: turn.end_ts ?? turn.ts };
  }
  return null;
}
