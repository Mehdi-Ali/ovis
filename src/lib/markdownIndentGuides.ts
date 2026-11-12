import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

/*
 * Local: indent guides for lists in Live edit. Atomic's inline preview hides a list line's leading
 * spaces and lays the item out from its depth in the syntax tree (padding-left = BASE + ALCOVE +
 * depth * 0.6em, the marker in a 1.2em alcove before the text). Guides drawn from the raw spaces
 * therefore miss the bullets, so these follow the same tree depth instead: every line owned by a
 * nested item gets a hairline under each ancestor's marker, and each level steps in STEP_EM (wider
 * than Atomic's 0.6em), so a child's marker sits past its parent's text as in the Preview.
 */
const BASE_EM = 0.8; // Atomic's LIST_BASE_EM
const ALCOVE_EM = 1.2; // Atomic's LIST_ALCOVE_EM
const STEP_EM = 1.5; // ours: a level is more than a whole alcove (Atomic: 0.6em)
const MARKER_CENTER_EM = 1.15; // the bullet's centre from its alcove's start (right-aligned in 0.9em, inline-preview.css), measured

function listDepthAt(state: EditorState, pos: number): number {
  let depth = -1;
  for (let node = syntaxTree(state).resolveInner(pos, 1) as { name: string; parent: unknown } | null; node; node = node.parent as typeof node) {
    if (node.name === "ListItem") depth++;
  }
  return depth;
}

function guideStyle(depth: number): string {
  const padding = BASE_EM + ALCOVE_EM + depth * STEP_EM;
  const rails: string[] = [];
  const positions: string[] = [];
  for (let k = 0; k < depth; k++) {
    rails.push("linear-gradient(var(--md-guide), var(--md-guide))");
    positions.push(`${(BASE_EM + k * STEP_EM + MARKER_CENTER_EM).toFixed(2)}em 0`);
  }
  let style = `padding-left: ${padding.toFixed(2)}em !important;`;
  if (depth > 0) {
    style += ` background-image: ${rails.join(", ")}; background-position: ${positions.join(", ")};`
      + ` background-size: var(--hairline, 1px) 100%; background-repeat: no-repeat;`;
  }
  return style;
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = state.doc.lineAt(pos);
      const offset = line.text.search(/\S/);
      if (offset >= 0) {
        const depth = listDepthAt(state, line.from + offset);
        if (depth >= 0) ranges.push(Decoration.line({ attributes: { style: guideStyle(depth) } }).range(line.from));
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

const guides = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = build(view); }
  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
      this.decorations = build(update.view);
    }
  }
}, { decorations: (plugin) => plugin.decorations });

export const markdownIndentGuides: Extension = [
  guides,
  EditorView.theme({ ".cm-content": { "--md-guide": "var(--border)" } }),
];
