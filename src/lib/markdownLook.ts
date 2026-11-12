import { HighlightStyle, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * The live editor drawn like the file viewer's Preview, beyond what CSS alone can reach:
 *
 * - its text colours, which Atomic Editor's own highlight style paints plain (bold and italics in the
 *   body colour, so the Preview's gruvbox roles never showed): this style replaces Atomic's;
 * - blank lines, which the Preview turns into a paragraph's margin: drawn short unless the caret is on one;
 * - fenced code, which the Preview draws as a rounded panel under a header naming its language: the
 *   first and last lines take the panel's corners, and the opening line names the language while the
 *   caret is outside the block (inside it, the fence shows as typed).
 */
const ovisHighlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: "var(--fw-semibold)" },
  { tag: t.strong, fontWeight: "var(--fw-semibold)", color: "var(--md-strong, var(--text-strong))" },
  { tag: t.emphasis, fontStyle: "italic", color: "var(--md-em, inherit)" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "var(--text-dim)" },
  { tag: t.monospace, fontFamily: "var(--font-mono)", color: "var(--md-code, var(--text-strong))" },
  { tag: [t.link, t.url], color: "var(--md-link, var(--accent))" },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: "var(--text-dim)" },
  { tag: t.quote, color: "var(--md-quote, var(--text-dim))" },
  // code inside fences: the app's syntax colours
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.self], color: "var(--syntax-keyword)" },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue, t.regexp], color: "var(--syntax-string)" },
  { tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom], color: "var(--syntax-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: "var(--syntax-type)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syntax-function)" },
  { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName), t.tagName], color: "var(--syntax-variable)" },
  { tag: [t.escape, t.operator], color: "var(--syntax-meta)" },
  { tag: t.invalid, color: "var(--syntax-deleted)" },
  { tag: [t.punctuation, t.bracket, t.squareBracket, t.paren, t.brace], color: "var(--text-dim)" },
]);

export const ovisMarkdownSyntax: Extension = syntaxHighlighting(ovisHighlight);

const blank = Decoration.line({ class: "cm-ovis-blank" });
const fenceFirst = (lang: string, label: boolean) => Decoration.line({ class: label ? "cm-ovis-fence-first cm-ovis-fence-label" : "cm-ovis-fence-first", attributes: { "data-lang": lang || "text" } });
const fenceLast = Decoration.line({ class: "cm-ovis-fence-last" });

/** The line numbers a selection touches. */
function touched(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number, last = state.doc.lineAt(range.to).number;
    for (let number = first; number <= last; number++) lines.add(number);
  }
  return lines;
}

function decorate(view: EditorView): DecorationSet {
  const { state } = view;
  const active = touched(state);
  const tree = syntaxTree(state);
  const marks: Array<{ at: number; deco: Decoration }> = [];
  for (const { from, to } of view.visibleRanges) {
    // fenced blocks in view: their first and last lines, and the lines inside (whose blank lines stay full height)
    const inCode = new Set<number>();
    tree.iterate({
      from, to,
      enter(node) {
        if (node.name !== "FencedCode") return;
        const first = state.doc.lineAt(node.from), last = state.doc.lineAt(node.to);
        let open = false;
        for (let number = first.number; number <= last.number; number++) { inCode.add(number); if (active.has(number)) open = true; }
        const lang = /^\s*(?:`{3,}|~{3,})\s*([^\s`]*)/.exec(first.text)?.[1] ?? "";
        if (first.from >= from) marks.push({ at: first.from, deco: fenceFirst(lang, !open) });
        if (last.number !== first.number && last.from <= to) marks.push({ at: last.from, deco: fenceLast });
        return false;
      },
    });
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      if (line.text.trim() === "" && !active.has(line.number) && !inCode.has(line.number)) marks.push({ at: line.from, deco: blank });
      pos = line.to + 1;
    }
  }
  marks.sort((a, b) => a.at - b.at);
  const builder = new RangeSetBuilder<Decoration>();
  let last = -1;
  for (const mark of marks) { if (mark.at !== last) builder.add(mark.at, mark.at, mark.deco); last = mark.at; }
  return builder.finish();
}

export const previewLook: Extension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = decorate(view); }
  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) this.decorations = decorate(update.view);
  }
}, { decorations: (plugin) => plugin.decorations });
