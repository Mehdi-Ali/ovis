import { useEffect, useId, useRef, useState } from "react";

import "./CacheChip.css";
import "./ContextChip.css";

import { contextLeftPercent, contextTone, formatTokens } from "../lib/compose.ts";
import { useT } from "../lib/i18n.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import type { CacheSummary } from "../../shared/claude-cache.ts";
import type { PaneContext } from "../../shared/protocol.ts";

/** the context size at which a long session should hand over to a fresh one; drawn only when the window is larger */
export const CONTEXT_RELAY_MARK = 200_000;

/** the average growth per request over the recent prompts, or null with fewer than two of them */
export function contextGrowth(prompts: number[]): number | null {
  if (prompts.length < 2) return null;
  return Math.round((prompts[prompts.length - 1]! - prompts[0]!) / (prompts.length - 1));
}

/**
 * The share of the context that is used (`ctx 34%`; just `34%` on a narrow screen), coloured by how
 * full it is: green up to a quarter, then yellow, orange past 45% and red past 60%. Pressed, it opens
 * a popover with the figures: tokens used and left, a bar with the colour marks, the relay mark, and
 * for a Claude Code session the last request's make-up, the recent prompt sizes with their growth,
 * and each recent subagent's own context. A window the transcript does not name draws no label.
 */
export function ContextChip({ context, cache, compact }: { context: PaneContext; cache: CacheSummary | undefined; compact: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  const left = contextLeftPercent(context);
  const shown = left !== null && context.window !== null;

  usePhoneSheetBack(() => setOpen(false), open && shown);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent): void => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (root.current?.contains(document.activeElement)) toggle.current?.focus();
      setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape); };
  }, [open]);

  if (!shown) return null;
  const window_ = context.window!;
  const used = 100 - left;
  const tone = contextTone(used);
  const label = t("Context {percent}% used", { percent: used });
  const detail = t("{used} of {window} tokens", { used: formatTokens(context.used), window: formatTokens(window_) });

  const main = cache?.main;
  const recent = main?.recent ?? [];
  const last = recent[recent.length - 1];
  const prompts = recent.map((request) => request.prompt).filter((prompt) => prompt > 0);
  const growth = contextGrowth(prompts);
  const relay = window_ > CONTEXT_RELAY_MARK ? CONTEXT_RELAY_MARK : null;
  const toRelay = relay === null ? null : relay - context.used;
  const requestsTo = (room: number): number | null => growth !== null && growth > 0 && room > 0 ? Math.floor(room / growth) : null;
  const toFull = requestsTo(window_ - context.used);
  const agents = (cache?.subagents ?? []).filter((agent) => agent.thread.last_prompt > 0);
  const mark = (percent: number) => <span className="context-bar-mark" style={{ left: `${percent}%` }} aria-hidden="true" />;

  return <span className="cache-chip-root" ref={root}>
    <button type="button" ref={toggle} className={`composer-context context-chip is-ctx-${tone}`} title={`${label} · ${detail}`} aria-label={`${label} · ${detail}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(!open)}>
      <span aria-hidden="true">{compact ? `${used}%` : t("ctx {percent}%", { percent: used })}</span>
    </button>
    {open && <div id={id} className="menu cache-menu context-menu" role="dialog" aria-label={t("Context")}>
      <p className="context-head">
        <span className={`is-ctx-${tone}`}>{label}</span>
        <span className="context-dim">{t("{left} left", { left: formatTokens(Math.max(0, window_ - context.used)) })}</span>
      </p>
      <div className="context-bar" role="presentation">
        <span className={`context-bar-fill is-ctx-${tone}`} style={{ width: `${Math.min(100, used)}%` }} />
        {mark(25)}{mark(45)}{mark(60)}
        {relay !== null && <span className="context-bar-mark is-relay" style={{ left: `${(relay / window_) * 100}%` }} aria-hidden="true" />}
      </div>
      <p className="cache-line">{detail}</p>
      {toRelay !== null && <p className={`cache-line${toRelay <= 0 ? " context-past-relay" : ""}`}>
        {toRelay > 0
          ? t("Relay mark {mark}: {n} to go", { mark: formatTokens(relay!), n: formatTokens(toRelay) })
          : t("Past the relay mark {mark} by {n}", { mark: formatTokens(relay!), n: formatTokens(-toRelay) })}
      </p>}
      {last && last.prompt > 0 && <p className="cache-line">
        {t("Last request: {cached} cached · {written} written · {fresh} new", {
          cached: formatTokens(last.read), written: formatTokens(last.write), fresh: formatTokens(Math.max(0, last.prompt - last.read - last.write)),
        })}
      </p>}
      {prompts.length >= 2 && <p className="cache-line context-trend">
        <span>{t("Last {n}:", { n: prompts.length })}</span>
        <span>{prompts.map(formatTokens).join(" · ")}</span>
        {growth !== null && <span className="context-growth">{t("{sign}{n}/request", { sign: growth >= 0 ? "+" : "−", n: formatTokens(Math.abs(growth)) })}</span>}
      </p>}
      {toFull !== null && <p className="cache-line">{t("≈{n} requests until full at this rate", { n: toFull })}</p>}
      {agents.length > 0 && <div className="cache-table context-agents" role="table">
        <div className="cache-row context-row cache-head" role="row">
          <span className="cache-label" role="columnheader">{t("Subagents")}</span>
          <span className="cache-left" role="columnheader">{t("context")}</span>
        </div>
        {agents.map((agent) => <div className="cache-row context-row is-sub" role="row" key={agent.id}>
          <span className="cache-label" role="cell" title={agent.title}>{agent.title}</span>
          <span className="cache-left" role="cell">{formatTokens(agent.thread.last_prompt)}</span>
        </div>)}
      </div>}
    </div>}
  </span>;
}
