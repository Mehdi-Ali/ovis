/**
 * The read side of the context breakdown: finds a Claude Code pane's main transcript and folds it.
 * The fold itself is in claude-context-breakdown.ts and takes lines only.
 */
import { readFile, stat } from "node:fs/promises";
import type { ContextBreakdown } from "../shared/context-breakdown.ts";
import { contextBreakdown } from "./claude-context-breakdown.ts";
import { ConversationUnavailable, paneTranscript } from "./conversation.ts";

/** a transcript past this is not read whole for an estimate */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

const cache = new Map<string, { signature: string; answer: ContextBreakdown }>();

/** The breakdown for a pane's Claude Code transcript, or null when the pane runs another agent. */
export async function paneContextBreakdown(paneId: string, codexHome?: string): Promise<ContextBreakdown | null> {
  const resolved = await paneTranscript(paneId, codexHome);
  if (resolved.source !== "claude-transcript") return null;
  const info = await stat(resolved.path);
  if (info.size > MAX_TRANSCRIPT_BYTES) throw new ConversationUnavailable("transcript_too_large");
  const signature = `${info.size}:${info.mtimeMs}`;
  const cached = cache.get(resolved.path);
  if (cached?.signature === signature) return cached.answer;
  const answer = contextBreakdown((await readFile(resolved.path, "utf8")).split("\n"));
  cache.set(resolved.path, { signature, answer });
  // a few panes at most are asked; the oldest answer goes first
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  return answer;
}
