/** One item of a group, such as a tool name, a hook or a skill. */
export type ContextBreakdownItem = { label: string; tokens: number };

/** One place the context goes: a part of the prompt with its estimated size. */
export type ContextBreakdownGroup = {
  key: string;
  label: string;
  tokens: number;
  items?: ContextBreakdownItem[];
};

/**
 * Where a Claude Code session's context goes, estimated from its transcript (GET /api/pane/context-breakdown).
 * `total` is the size of the latest request's prompt; the groups sum to it, largest first.
 */
export type ContextBreakdown = {
  total: number;
  /** the time of the request the total comes from, or null when the transcript has no request yet */
  measured_at: number | null;
  groups: ContextBreakdownGroup[];
  estimated: true;
};
