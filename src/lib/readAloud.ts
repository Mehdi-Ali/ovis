// local patch: read-aloud helpers, ported from the Claude Code console mod
// (~/.claude/mods/read-aloud/hooks/register.tsx). Pure text work: the sentence split, the
// markdown-to-speech clean-up, the word being said, and where a sentence sits in rendered text.

export const READ_COLOR = "#9a6cf0"; // the sentence being read
export const WORD_COLOR = "#ecdfff"; // the word being said
export const MAX_CHARS = 8000;

export interface Segment { raw: string; speech: string }

/** Markdown to plain speech: drop code and URLs, keep link text. */
export function toSpeech(md: string): string {
  return md
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+|file:\/\/\/\S+/g, " ")
    .replace(/\|/g, ", ")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/[*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split markdown into sentences, each kept as written (to find it on screen) and as speech. Code
 * blocks and table rules are skipped. Past `max` characters the rest is replaced by one line.
 */
export function segment(md: string, max = MAX_CHARS): Segment[] {
  const out: Segment[] = [];
  let total = 0;
  const prose = md.replace(/```[\s\S]*?(?:```|$)/g, "\n\n");
  for (const line of prose.split("\n")) {
    if (/^\s*\|?[-:| ]+\|[-:| ]*$/.test(line)) continue;
    // after . ! or ? (and any closing ** ` ) " ' ]) before a space, so every character of the
    // line lands in some sentence
    for (const piece of line.split(/(?<=[.!?][*_`)"'\]]*)\s+/)) {
      const raw = piece.trim();
      const speech = toSpeech(raw);
      if (!raw || !/\w/.test(speech)) continue;
      total += speech.length;
      if (total > max) return [...out, { raw: "", speech: "The rest is on screen." }];
      out.push({ raw, speech });
    }
  }
  return out;
}

/** Which word of `raw` is being said `elapsed` ms into a sentence lasting `duration`. */
export function wordAt(raw: string, elapsed: number, duration: number): number {
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const total = words.reduce((n, w) => n + w.length + 1, 0);
  const target = Math.min(1, Math.max(0, elapsed) / Math.max(1, duration)) * total;
  let seen = 0;
  for (let i = 0; i < words.length; i++) {
    seen += (words[i]?.length ?? 0) + 1;
    if (seen >= target) return i;
  }
  return words.length - 1;
}

// Characters ignored when matching a sentence against rendered text: rendering drops backticks,
// ** and bullets, and wraps lines differently.
const LOOSE_SKIP = /[\s*_`~#>|•│─┌┐└┘├┤┬┴┼]/;

/** `s` with the skipped characters removed, and the index in `s` of each kept one. */
export function loose(s: string): { flat: string; map: number[] } {
  let flat = "";
  const map: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? "";
    if (LOOSE_SKIP.test(ch)) continue;
    flat += ch;
    map.push(i);
  }
  return { flat, map };
}

/**
 * Where `raw` sits in `text`, as [start, end). The sentences before it (`before`, in order) are
 * matched first, so a repeated phrase (a "Yes" in several table cells) lands on the right copy.
 */
export function locate(text: string, raw: string, before: readonly string[] = []): [number, number] | null {
  const t = loose(text);
  const want = loose(raw).flat;
  if (!want) return null;
  let from = 0;
  for (const earlier of before) {
    const r = loose(earlier).flat;
    const found = r ? t.flat.indexOf(r, from) : -1;
    if (found >= 0) from = found + r.length;
  }
  let found = t.flat.indexOf(want, from);
  if (found < 0) found = t.flat.indexOf(want);
  if (found < 0) return null;
  return [t.map[found] ?? 0, (t.map[found + want.length - 1] ?? 0) + 1];
}

/** A stretch of a list of text nodes: the node index and the offset in it of each end. */
export interface TextSpan { startNode: number; startOffset: number; endNode: number; endOffset: number }

function spanOf(texts: readonly string[], from: number, to: number): TextSpan | null {
  let startNode = -1;
  let endNode = -1;
  let base = 0;
  let startBase = 0;
  let endBase = 0;
  for (let i = 0; i < texts.length; i++) {
    const len = texts[i]!.length;
    // a start belongs to the node holding its first character, an end to the one holding its last
    if (startNode < 0 && from < base + len) { startNode = i; startBase = base; }
    if (to > base && to <= base + len) { endNode = i; endBase = base; break; }
    base += len;
  }
  if (startNode < 0 || endNode < 0) return null;
  return { startNode, startOffset: from - startBase, endNode, endOffset: to - endBase };
}

/** `locate` over a list of text nodes' contents (as the DOM holds them): the node and offset of each end. */
export function locateInTexts(texts: readonly string[], raw: string, before: readonly string[] = []): TextSpan | null {
  const span = locate(texts.join(""), raw, before);
  return span === null ? null : spanOf(texts, span[0], span[1]);
}

/** Where the `word`th word of `raw` sits inside `sentence` (a span of `texts`); earlier words are matched in order. */
export function wordSpanInTexts(texts: readonly string[], sentence: TextSpan, raw: string, word: number): TextSpan | null {
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (word >= tokens.length) return null;
  const starts: number[] = [];
  let base = 0;
  for (const t of texts) { starts.push(base); base += t.length; }
  const a = (starts[sentence.startNode] ?? 0) + sentence.startOffset;
  const b = (starts[sentence.endNode] ?? 0) + sentence.endOffset;
  const flat = loose(texts.join("").slice(a, b));
  let from = 0;
  for (let i = 0; i <= word; i++) {
    const want = loose(tokens[i] ?? "").flat;
    if (!want) continue;
    const found = flat.flat.indexOf(want, from);
    if (found < 0) return null;
    from = found + want.length;
    if (i === word) return spanOf(texts, a + (flat.map[found] ?? 0), a + (flat.map[found + want.length - 1] ?? 0) + 1);
  }
  return null;
}
