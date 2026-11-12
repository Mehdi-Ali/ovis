// local patch: read-aloud for the chat view. Sentences are fetched one at a time from
// POST /api/pane/tts (server/tts.ts, Kokoro) a couple ahead of the one playing, and played through
// ONE reused HTMLAudioElement, so the permission a phone gives the first tap holds for the rest.
// The sentence and the word being said are painted with the CSS Custom Highlight API: nothing in
// React's DOM is touched, and a browser without the API simply reads without highlighting.
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { fetchSpeech } from "./api.ts";
import { locateInTexts, segment, wordAt, wordSpanInTexts, type Segment, type TextSpan } from "./readAloud.ts";

export type ReadState = "idle" | "loading" | "playing" | "paused";

const AHEAD = 2; // sentences fetched past the one playing
const SENTENCE_HL = "read-aloud-sentence";
const WORD_HL = "read-aloud-word";

interface Source { text: string; range: Range | null }
interface Run { id: number; segs: Segment[]; urls: Map<number, Promise<string>>; abort: AbortController; source: Source }

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => { priority: number };

function registry(): { highlights: HighlightRegistry; Highlight: HighlightCtor } | null {
  const highlights = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight;
  return highlights && Highlight ? { highlights, Highlight } : null;
}

function clearHighlights() {
  const reg = registry();
  reg?.highlights.delete(SENTENCE_HL);
  reg?.highlights.delete(WORD_HL);
}

/** The text nodes under `root` that hold words of the message: not buttons, not a turn's time and copy row. */
function textNodes(root: Node, within: Range | null): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeValue === null || node.nodeValue === "") return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest("button, .chat-turn-meta, .read-aloud-controls")) return NodeFilter.FILTER_REJECT;
      if (within !== null && !within.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) out.push(n as Text);
  return out;
}

function rangeOf(nodes: readonly Text[], span: TextSpan): Range | null {
  const a = nodes[span.startNode];
  const b = nodes[span.endNode];
  if (!a || !b || !a.isConnected || !b.isConnected) return null;
  try {
    const range = document.createRange();
    range.setStart(a, span.startOffset);
    range.setEnd(b, span.endOffset);
    return range;
  } catch {
    return null;
  }
}

export interface ReadAloud {
  state: ReadState;
  /** pointerdown on the Read button: holds the selection before the press can clear it */
  capture: () => void;
  start: () => void;
  toggle: () => void;
  stop: () => void;
}

/**
 * `frame` is the chat's message area: only a selection inside it is read, and the last reply is
 * found in it. `lastReply` is that reply's markdown, `active` false stops any reading.
 */
export function useReadAloud(opts: { paneId: string; machineId: string; frame: RefObject<HTMLElement | null>; lastReply: () => string; active: boolean }): ReadAloud {
  const { paneId, machineId, frame, active } = opts;
  const lastReply = useRef(opts.lastReply);
  lastReply.current = opts.lastReply;
  const [state, setState] = useState<ReadState>("idle");
  const audio = useRef<HTMLAudioElement | null>(null);
  const run = useRef<Run | null>(null);
  const counter = useRef(0);
  const held = useRef<Source | null>(null);
  const raf = useRef(0);
  const nodes = useRef<{ texts: string[]; list: Text[]; sentence: TextSpan | null; seg: Segment | null }>({ texts: [], list: [], sentence: null, seg: null });
  const alive = useRef(true);

  const release = useCallback((r: Run) => {
    r.abort.abort();
    for (const url of r.urls.values()) void url.then((u) => URL.revokeObjectURL(u), () => undefined);
    r.urls.clear();
  }, []);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    const r = run.current;
    run.current = null;
    if (r) release(r);
    const el = audio.current;
    if (el) {
      el.onended = null;
      el.onerror = null;
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    clearHighlights();
    nodes.current = { texts: [], list: [], sentence: null, seg: null };
    if (alive.current) setState("idle");
  }, [release]);

  const paintWord = useCallback(() => {
    const r = run.current;
    const el = audio.current;
    const reg = registry();
    const n = nodes.current;
    if (!r || !el || !reg || !n.sentence || !n.seg) return;
    const duration = Number.isFinite(el.duration) && el.duration > 0 ? el.duration * 1000 : 0;
    if (duration === 0) return;
    const word = wordAt(n.seg.raw, el.currentTime * 1000, duration);
    const span = wordSpanInTexts(n.texts, n.sentence, n.seg.raw, word);
    const range = span ? rangeOf(n.list, span) : null;
    if (!range) { reg.highlights.delete(WORD_HL); return; }
    const hl = new reg.Highlight(range);
    hl.priority = 1;
    reg.highlights.set(WORD_HL, hl);
  }, []);

  const paintSentence = useCallback((r: Run, index: number) => {
    const reg = registry();
    const seg = r.segs[index];
    if (!reg || !seg || !seg.raw) { clearHighlights(); nodes.current = { texts: [], list: [], sentence: null, seg: null }; return; }
    const common = r.source.range?.commonAncestorContainer ?? null;
    const replies = frame.current?.querySelectorAll(".chat-turn-agent");
    const root = common ? (common.nodeType === Node.TEXT_NODE ? common.parentNode : common) : replies?.item(replies.length - 1) ?? null;
    if (!root) { clearHighlights(); return; }
    const list = textNodes(root, r.source.range);
    const texts = list.map((t) => t.nodeValue ?? "");
    const before = r.segs.slice(0, index).map((s) => s.raw).filter(Boolean);
    const sentence = locateInTexts(texts, seg.raw, before);
    const range = sentence ? rangeOf(list, sentence) : null;
    reg.highlights.delete(WORD_HL);
    if (!range) { reg.highlights.delete(SENTENCE_HL); nodes.current = { texts: [], list: [], sentence: null, seg: null }; return; }
    const hl = new reg.Highlight(range);
    reg.highlights.set(SENTENCE_HL, hl);
    nodes.current = { texts, list, sentence, seg };
  }, [frame]);

  const tick = useCallback(() => {
    paintWord();
    raf.current = requestAnimationFrame(tick);
  }, [paintWord]);

  const fetchAhead = useCallback((r: Run, from: number) => {
    for (let i = from; i < Math.min(r.segs.length, from + AHEAD + 1); i++) {
      if (r.urls.has(i)) continue;
      const speech = r.segs[i]!.speech.slice(0, 2000);
      r.urls.set(i, fetchSpeech(speech, machineId, r.abort.signal).then((blob) => URL.createObjectURL(blob)));
    }
  }, [machineId]);

  const playFrom = useCallback(async (r: Run, index: number) => {
    const el = audio.current;
    if (!el || run.current !== r) return;
    if (index >= r.segs.length) { stop(); return; }
    fetchAhead(r, index);
    let url: string;
    try {
      url = await r.urls.get(index)!;
    } catch (error) {
      if (run.current === r) { console.warn("read aloud: speech failed", error); stop(); }
      return;
    }
    if (run.current !== r) return;
    el.onended = () => {
      const done = r.urls.get(index);
      r.urls.delete(index);
      void done?.then((u) => URL.revokeObjectURL(u), () => undefined);
      void playFrom(r, index + 1);
    };
    el.onerror = () => { if (run.current === r) stop(); };
    el.src = url;
    try {
      await el.play();
    } catch (error) {
      if (run.current === r) { console.warn("read aloud: playback refused", error); stop(); }
      return;
    }
    if (run.current !== r) return;
    paintSentence(r, index);
    setState("playing");
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
  }, [fetchAhead, paintSentence, stop, tick]);

  const capture = useCallback(() => {
    const sel = typeof getSelection === "function" ? getSelection() : null;
    const root = frame.current;
    held.current = null;
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) return;
    const range = sel.getRangeAt(0);
    const text = sel.toString();
    // only a selection inside this chat's messages is read
    if (!text.trim() || !root.contains(range.commonAncestorContainer)) return;
    held.current = { text, range: range.cloneRange() };
  }, [frame]);

  const start = useCallback(() => {
    // a press that had no pointerdown first (a key) reads the selection now
    if (held.current === null) capture();
    const picked = held.current;
    held.current = null;
    const text = picked?.text ?? lastReply.current();
    const segs = segment(text);
    if (segs.length === 0) return;
    stop();
    // the element is made inside the tap, so a phone keeps its permission to play for later sentences
    if (!audio.current) { audio.current = new Audio(); audio.current.preload = "auto"; }
    const r: Run = { id: ++counter.current, segs, urls: new Map(), abort: new AbortController(), source: picked ?? { text, range: null } };
    run.current = r;
    setState("loading");
    void playFrom(r, 0);
  }, [capture, playFrom, stop]);

  const toggle = useCallback(() => {
    const el = audio.current;
    if (!el || !run.current) return;
    if (el.paused) {
      void el.play().then(() => setState("playing"), () => undefined);
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(tick);
    } else {
      el.pause();
      cancelAnimationFrame(raf.current);
      setState("paused");
    }
  }, [tick]);

  // switching pane (the chat hidden or another pane focused) and unmounting stop the reading
  useEffect(() => { if (!active) stop(); }, [active, stop]);
  useEffect(() => { stop(); }, [paneId, stop]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; stop(); audio.current = null; };
  }, [stop]);

  return { state, capture, start, toggle, stop };
}
