import { useSyncExternalStore } from "react";
import { Timer } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import { cacheMinutes, cacheTone } from "../../shared/claude-cache.ts";
import type { PaneCache } from "../../shared/protocol.ts";

/** every row counts down on this tick, from its last request's time: no server poll for it */
export const AGENT_CACHE_TICK_MS = 30_000;

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** One clock for all the rows: it runs while a row shows a mark, and is read again as the first one mounts. */
function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    now = Date.now();
    timer = setInterval(() => { now = Date.now(); for (const tell of listeners) tell(); }, AGENT_CACHE_TICK_MS);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) { clearInterval(timer); timer = null; }
  };
}

const read = (): number => now;

/**
 * A Claude agent's prompt cache on its sidebar row: the estimated minutes left (`⏱42m`, green over 15,
 * yellow below) or `≈cold` in grey, by the composer chip's rules (shared/claude-cache.ts). The main
 * session's only, and an estimate: Anthropic does not report when a cache entry expires. Drawn only
 * once the pane's answers reported usage.
 */
export function AgentCacheMark({ cache }: { cache: PaneCache | undefined }) {
  const t = useT();
  const clock = useSyncExternalStore(subscribe, read, read);
  if (cache === undefined) return null;
  const left = Math.max(0, cache.last_at + cache.ttl_ms - clock);
  const tone = cacheTone(left);
  const word = left <= 0 ? t("≈cold") : `${cacheMinutes(left)}m`;
  const label = t("Prompt cache (est.)");
  return (
    <span className={`agent-cache is-${tone}`} title={label} aria-label={`${label}: ${word}`} data-testid="agent-cache">
      {left > 0 && <Timer aria-hidden="true" />}{word}
    </span>
  );
}
