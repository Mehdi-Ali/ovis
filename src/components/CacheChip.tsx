import { useEffect, useId, useRef, useState } from "react";
import { Timer } from "lucide-react";

import "./CacheChip.css";

import { formatTokens } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import { cacheHitPercent, cacheLeftMs, cacheMinutes, cacheTone, CACHE_RECENT, type CacheSummary, type CacheThread } from "../../shared/claude-cache.ts";

/** the chip counts down on this tick, from the last request's time: no server poll for it */
export const CACHE_TICK_MS = 30_000;

/** how long is left as the chip and the popover say it: whole minutes, or `≈cold` */
function leftWord(left: number | null, cold: string): string {
  return left === null ? "–" : left <= 0 ? cold : `${cacheMinutes(left)}m`;
}

/**
 * The prompt cache of a Claude Code session, as a chip in the composer's status row and, pressed,
 * a popover with its figures: the main session and each recent subagent, what was read and written,
 * the last five requests and what a cold cache costs to rewrite. The counts are what the transcript
 * recorded; the time left is an estimate (Anthropic does not report when a cache entry expires), so
 * everything here says so. Drawn only once an answer reported usage.
 */
export function CacheChip({ cache, compact }: { cache: CacheSummary | undefined; compact: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const shown = cache !== undefined && cache.main.requests > 0;

  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CACHE_TICK_MS);
    return () => clearInterval(timer);
  }, [shown]);

  // the phone's Back closes it, as it closes any sheet
  usePhoneSheetBack(() => setOpen(false), open && shown);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // the popover unmounts with whatever inside it held the focus: hand it back to the chip
      if (root.current?.contains(document.activeElement)) toggle.current?.focus();
      setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);

  if (!shown) return null;
  const main = cache.main;
  const left = cacheLeftMs(main, true, now) ?? 0;
  const tone = cacheTone(left);
  const cold = t("≈cold");
  const word = leftWord(left, cold);
  const estimate = t("Estimated: Anthropic does not report cache expiry");
  const name = left <= 0 ? t("Prompt cache probably cold") : t("Prompt cache, about {time} left", { time: word });

  const row = (label: string, thread: CacheThread, isMain: boolean, sub: boolean) => {
    const rowLeft = leftWord(cacheLeftMs(thread, isMain, now), cold);
    const hit = cacheHitPercent(thread);
    return <div className={`cache-row${sub ? " is-sub" : ""}`} role="row" key={`${isMain}-${label}-${thread.last_at}`}>
      <span className="cache-label" role="cell" title={label}>{label}</span>
      <span className={`cache-left${rowLeft === cold ? " is-cold" : ""}`} role="cell">{rowLeft}</span>
      <span className="cache-hit" role="cell">{hit === null ? "–" : `${hit}%`}</span>
    </div>;
  };

  const agents = cache.subagents ?? [];
  const read = main.cache_read + agents.reduce((sum, agent) => sum + agent.thread.cache_read, 0);
  const write = main.cache_write + agents.reduce((sum, agent) => sum + agent.thread.cache_write, 0);
  const recent = main.recent.slice(-CACHE_RECENT);

  return <span className="cache-chip-root" ref={root}>
    <button type="button" ref={toggle} className={`cache-chip is-${tone}${compact ? " is-compact" : ""}`} aria-label={name} title={estimate} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => { setNow(Date.now()); setOpen(!open); }}>
      <Timer aria-hidden="true" />
      <span aria-hidden="true">{word}</span>
    </button>
    {open && <div id={id} className="menu cache-menu" role="dialog" aria-label={t("Prompt cache (estimated)")} title={estimate}>
      <div className="cache-table" role="table">
        <div className="cache-row cache-head" role="row">
          <span className="cache-label" role="columnheader">{t("Cache (est.)")}</span>
          <span className="cache-left" role="columnheader">{t("left")}</span>
          <span className="cache-hit" role="columnheader">{t("hit")}</span>
        </div>
        {row(t("Main session"), main, true, false)}
        {agents.map((agent) => row(agent.title, agent.thread, false, true))}
      </div>
      <p className="cache-line">{t("Read {read} · Write {write}", { read: formatTokens(read), write: formatTokens(write) })}</p>
      <p className="cache-line cache-recent">
        <span>{t("Last {n}:", { n: CACHE_RECENT })}</span>
        {recent.map((request, index) => request.miss
          ? <span key={index} className="cache-miss">{t("✗ miss (wrote {n})", { n: formatTokens(request.write) })}</span>
          : <span key={index} className="cache-ok" aria-label={t("cache hit")}>✓</span>)}
      </p>
      {left <= 0 && <p className="cache-line cache-cold-now">{t("Cold now: next send rewrites ~{n}", { n: formatTokens(main.last_prompt) })}</p>}
    </div>}
  </span>;
}
