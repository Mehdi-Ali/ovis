/**
 * Where a Claude Code session's context goes, like Claude Code's own /context, estimated from the
 * transcript. The transcript keeps the text of everything injected into the prompt (system prompt,
 * CLAUDE.md, skill and agent listings, hook output, messages, tool calls and results) but not the
 * tool definitions, which are derived from the first request's size. Every piece is estimated by
 * its length, then the pieces are scaled so they add up to what the latest request really held.
 */
import type { ContextBreakdown, ContextBreakdownGroup, ContextBreakdownItem } from "../shared/context-breakdown.ts";

/** how many characters one token is taken to be; the transcript holds text, not token counts */
export const CHARS_PER_TOKEN = 4;
/** the items kept per group, largest first */
const MAX_ITEMS = 20;

const LABELS: Record<string, string> = {
  system: "System prompt",
  tools: "Tool definitions",
  memory: "Memory and CLAUDE.md",
  skills_list: "Skills list",
  skills_loaded: "Skills loaded",
  agents: "Agents list",
  mcp: "MCP instructions",
  deferred: "Deferred tools list",
  hooks: "Hooks",
  reminders: "Reminders and other",
  user: "Your messages",
  assistant: "Claude's replies",
  thinking: "Thinking",
  toolcalls: "Tool calls and results",
};

type Entry = Record<string, unknown>;
/** a transcript line, or the entry it parses to */
export type TranscriptLine = string | Entry;

const isRecord = (value: unknown): value is Entry => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => typeof value === "string" ? value : "";
const lengthOf = (value: unknown): number => {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce<number>((sum, part) => sum + lengthOf(part), 0);
  if (isRecord(value)) return JSON.stringify(value).length;
  return 0;
};

/** the characters of a tool result's content: text blocks only, a picture is not text */
function resultLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let sum = 0;
  for (const part of content) {
    if (isRecord(part) && part.type === "text") sum += text(part.text).length;
    else if (typeof part === "string") sum += part.length;
  }
  return sum;
}

/** `mcp__server__tool` is grouped by its server */
function toolItem(name: string): string {
  const match = /^mcp__(.+?)__/.exec(name);
  return match ? `mcp:${match[1]}` : name;
}

function parseLine(line: TranscriptLine): Entry | null {
  if (typeof line !== "string") return line;
  if (line.length === 0) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch { return null; }
}

/** The size of one request's prompt, or 0 for an entry that is not a main-thread model request. */
function promptOf(entry: Entry): number {
  if (entry.type !== "assistant" || entry.isSidechain === true || entry.isApiErrorMessage === true) return 0;
  const message = entry.message;
  if (!isRecord(message) || !isRecord(message.usage) || message.model === "<synthetic>") return 0;
  const usage = message.usage;
  const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
  return count(usage.input_tokens) + count(usage.cache_read_input_tokens) + count(usage.cache_creation_input_tokens);
}

/** The characters counted per group, and per item within it. */
class Tally {
  readonly groups = new Map<string, { chars: number; items: Map<string, number> }>();
  add(key: string, chars: number, item?: string): void {
    if (chars <= 0) return;
    const group = this.groups.get(key) ?? { chars: 0, items: new Map() };
    group.chars += chars;
    if (item !== undefined) group.items.set(item, (group.items.get(item) ?? 0) + chars);
    this.groups.set(key, group);
  }
  sum(): number {
    let sum = 0;
    for (const group of this.groups.values()) sum += group.chars;
    return sum;
  }
}

/** Counts what one attachment entry injected into the prompt. */
function attachment(tally: Tally, body: Entry): void {
  const hook = text(body.hookEvent) || text(body.hookName) || "hook";
  switch (body.type) {
    case "instructions":
      for (const file of Array.isArray(body.files) ? body.files : []) if (isRecord(file)) tally.add("memory", text(file.content).length, text(file.path) || "memory file");
      return;
    case "skill_listing": tally.add("skills_list", text(body.content).length); return;
    case "agent_listing_delta": tally.add("agents", lengthOf(body.addedLines)); return;
    case "mcp_instructions_delta": tally.add("mcp", lengthOf(body.addedBlocks)); return;
    case "deferred_tools_delta": tally.add("deferred", lengthOf(body.addedLines) + lengthOf(body.surfacedDefinitions)); return;
    case "hook_success": tally.add("hooks", text(body.content).length, hook); return;
    case "hook_additional_context": tally.add("hooks", lengthOf(body.content), hook); return;
    case "hook_non_blocking_error": tally.add("hooks", text(body.stderr).length, hook); return;
    case "output_style": tally.add("reminders", text(body.turnReminder).length, "output style"); return;
    case "output_style_instructions": tally.add("reminders", isRecord(body.style) ? text(body.style.prompt).length : 0, "output style"); return;
    case "environment": tally.add("reminders", lengthOf(body.snapshot), "environment"); return;
    case "session_context": tally.add("reminders", lengthOf(body.context), "session context"); return;
    case "model": tally.add("reminders", text(body.text).length, "model"); return;
    case "date": tally.add("reminders", text(body.date).length, "date"); return;
    case "silent_turn_reminder": tally.add("reminders", text(body.text).length, "turn reminder"); return;
    case "auto_mode": tally.add("reminders", lengthOf(body.bashFirstSteer), "auto mode"); return;
    default: return;
  }
}

/** A user entry's text: a skill's body (a slash command's or an invoked skill's) counts under skills loaded, the rest as the user's. */
function userText(tally: Tally, body: string): void {
  const command = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(body);
  if (command !== null || body.startsWith("Base directory for this skill:")) tally.add("skills_loaded", body.length, command?.[1] ?? "skill");
  else tally.add("user", body.length);
}

function itemsOf(items: Map<string, number>, scale: number): ContextBreakdownItem[] {
  return [...items]
    .map(([label, chars]) => ({ label, tokens: Math.round((chars / CHARS_PER_TOKEN) * scale) }))
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_ITEMS);
}

/**
 * Where the context goes, from a session's transcript lines (or entries already parsed). Only what
 * follows the latest compact boundary counts, the system prompt aside. Unreadable lines are skipped.
 */
export function contextBreakdown(lines: Iterable<TranscriptLine>): ContextBreakdown {
  let tally = new Tally();
  let system = 0;
  /** tool_use id to the group and item its call and result are counted under */
  let calls = new Map<string, { key: string; item: string }>();
  let firstPrompt = 0;
  let beforeFirst = 0;
  let measured = 0;
  let measuredAt: number | null = null;

  for (const raw of lines) {
    const entry = parseLine(raw);
    if (entry === null) continue;
    if (entry.type === "system" && entry.subtype === "compact_boundary") {
      tally = new Tally();
      calls = new Map();
      firstPrompt = 0;
      beforeFirst = 0;
      continue;
    }
    if (entry.type === "attachment" && isRecord(entry.attachment)) {
      if (entry.attachment.type === "prompt_snapshot") system = lengthOf(entry.attachment.systemPrompt);
      else attachment(tally, entry.attachment);
      continue;
    }
    if (entry.isSidechain === true) continue;
    const message = isRecord(entry.message) ? entry.message : null;
    if (message === null) continue;
    if (entry.type === "assistant") {
      const prompt = promptOf(entry);
      if (prompt > 0) {
        // the first request after the start or a compaction shows what the prompt held before any reply
        if (firstPrompt === 0) { firstPrompt = prompt; beforeFirst = tally.sum() + system; }
        measured = prompt;
        const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
        measuredAt = Number.isFinite(at) ? at : measuredAt;
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRecord(block)) continue;
        if (block.type === "text") tally.add("assistant", text(block.text).length);
        else if (block.type === "thinking") tally.add("thinking", text(block.thinking).length);
        else if (block.type === "tool_use") {
          const name = text(block.name) || "tool";
          const input = isRecord(block.input) ? block.input : {};
          if (name === "Skill") {
            const skill = text(input.skill) || text(input.name) || "skill";
            calls.set(text(block.id), { key: "skills_loaded", item: skill });
            tally.add("skills_loaded", lengthOf(input), skill);
          } else {
            const item = toolItem(name);
            calls.set(text(block.id), { key: "toolcalls", item });
            tally.add("toolcalls", name.length + lengthOf(input), item);
          }
        }
      }
    } else if (entry.type === "user") {
      const content = message.content;
      if (typeof content === "string") userText(tally, content);
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text") userText(tally, text(block.text));
          else if (block.type === "tool_result") {
            const call = calls.get(text(block.tool_use_id)) ?? { key: "toolcalls", item: "unknown tool" };
            tally.add(call.key, resultLength(block.content), call.item);
          }
        }
      }
    }
  }

  // the tool definitions are what the first request held beyond everything counted before it
  const toolChars = firstPrompt > 0 ? Math.max(0, firstPrompt * CHARS_PER_TOKEN - beforeFirst) : 0;
  const pieces = new Map(tally.groups);
  if (system > 0) pieces.set("system", { chars: system, items: new Map() });
  const countedTokens = [...pieces.values()].reduce((sum, group) => sum + group.chars, 0) / CHARS_PER_TOKEN;
  const total = measured > 0 ? measured : Math.round(countedTokens + toolChars / CHARS_PER_TOKEN);
  const toolTokens = Math.min(toolChars / CHARS_PER_TOKEN, total);
  // the counted pieces share what the tools leave of the measured size
  const scale = measured > 0 && countedTokens > 0 ? Math.max(0, total - toolTokens) / countedTokens : 1;

  const groups: ContextBreakdownGroup[] = [];
  for (const [key, group] of pieces) {
    const tokens = Math.round((group.chars / CHARS_PER_TOKEN) * scale);
    if (tokens <= 0) continue;
    const items = itemsOf(group.items, scale);
    groups.push({ key, label: LABELS[key] ?? key, tokens, ...(items.length > 0 ? { items } : {}) });
  }
  if (toolTokens > 0) groups.push({ key: "tools", label: LABELS["tools"]!, tokens: Math.round(toolTokens) });
  groups.sort((a, b) => b.tokens - a.tokens);
  // rounding leaves a few tokens over or short; the largest group takes them so the groups add up to the total
  const drift = total - groups.reduce((sum, group) => sum + group.tokens, 0);
  if (groups.length > 0 && groups[0]!.tokens + drift > 0) groups[0]!.tokens += drift;
  return { total, measured_at: measured > 0 ? measuredAt : null, groups, estimated: true };
}
