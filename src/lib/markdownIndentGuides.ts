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
const ALCOVE_EM = 1.2; // Atomic's LIST_ALCOVE_EM: the first line's text-indent pulls the marker back by this
const STEP_EM = 1.5; // ours: a level steps in this far (Atomic: 0.6em)
// Ovis draws a bullet or number right-aligned in a 1.4em box (MarkdownLiveEditor.css), so its right
// edge is 0.2em past the content column; a checkbox keeps Atomic's 1.2em alcove, centred ~0.55em in.
const MARK_END_EM = 1.4 - ALCOVE_EM;
const BULLET_HALF_EM = 0.2;
const DIGIT_EM = 0.55;
const DOT_EM = 0.28;
const CHECKBOX_CENTER_EM = 0.55;

type Node = { name: string; from: number; to: number; parent: Node | null; firstChild: Node | null; nextSibling: Node | null };

/** Where a list item's marker is centred, from the start of its own alcove's content column, in em. */
function markerCenter(state: EditorState, item: Node): number {
  let mark: Node | null = null;
  let task = false;
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (child.name === "ListMark" && mark === null) mark = child;
    if (child.name === "Task") task = true;
  }
  if (task) return CHECKBOX_CENTER_EM - ALCOVE_EM;
  const text = mark === null ? "-" : state.doc.sliceString(mark.from, mark.to);
  if (/^[-*+]$/.test(text)) return MARK_END_EM - BULLET_HALF_EM;
  const width = (text.length - 1) * DIGIT_EM + DOT_EM;
  return MARK_END_EM - width / 2;
}

/** The list items enclosing a position, outermost first. */
function listItemsAt(state: EditorState, pos: number): Node[] {
  const items: Node[] = [];
  for (let node = syntaxTree(state).resolveInner(pos, 1) as unknown as Node | null; node; node = node.parent) {
    if (node.name === "ListItem") items.unshift(node);
  }
  return items;
}

function guideStyle(state: EditorState, items: Node[]): string {
  const depth = items.length - 1;
  const column = (k: number): number => BASE_EM + ALCOVE_EM + k * STEP_EM;
  let style = `padding-left: ${column(depth).toFixed(2)}em !important;`;
  if (depth > 0) {
    const positions = items.slice(0, depth).map((item, k) => `${(column(k) + markerCenter(state, item)).toFixed(2)}em 0`);
    style += ` background-image: ${positions.map(() => "linear-gradient(var(--md-guide), var(--md-guide))").join(", ")};`
      + ` background-position: ${positions.join(", ")}; background-size: var(--hairline, 1px) 100%; background-repeat: no-repeat;`;
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
        const items = listItemsAt(state, line.from + offset);
        if (items.length > 0) ranges.push(Decoration.line({ attributes: { style: guideStyle(state, items) } }).range(line.from));
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
