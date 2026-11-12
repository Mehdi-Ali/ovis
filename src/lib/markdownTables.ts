import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, RangeSetBuilder, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";

/**
 * GFM tables in the live editor, the way Obsidian's source reveal works: a table is drawn (as the
 * Preview draws it, `.markdown table`) until the caret enters it; then every line of it is its raw
 * markdown, to edit as text, and it is drawn again once the caret leaves. Pressing a drawn table puts
 * the caret in it.
 */

type Align = "left" | "center" | "right" | null;

/** A table row's cells: the text between unescaped pipes, without the outer ones. */
export function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let code = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\\" && text[index + 1] === "|") { cell += "|"; index++; continue; }
    if (char === "`") code = !code;
    if (char === "|" && !code) { cells.push(cell.trim()); cell = ""; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

const alignOf = (delimiter: string): Align => {
  const left = delimiter.startsWith(":"), right = delimiter.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
};

/** `**bold**`, `*em*`/`_em_`, `` `code` `` and `[text](url)` in a cell, as DOM nodes (never as HTML). */
export function inlineNodes(text: string, doc: Document): Node[] {
  const nodes: Node[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(doc.createTextNode(text.slice(last, match.index)));
    const [, code, bold, bold2, em, em2, label, href] = match;
    if (code !== undefined) { const node = doc.createElement("code"); node.textContent = code; nodes.push(node); }
    else if (bold !== undefined || bold2 !== undefined) { const node = doc.createElement("strong"); node.append(...inlineNodes(bold ?? bold2 ?? "", doc)); nodes.push(node); }
    else if (em !== undefined || em2 !== undefined) { const node = doc.createElement("em"); node.append(...inlineNodes(em ?? em2 ?? "", doc)); nodes.push(node); }
    else if (label !== undefined && href !== undefined) {
      const node = doc.createElement("a");
      node.textContent = label;
      node.setAttribute("href", href);
      node.dataset.href = href;
      nodes.push(node);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(doc.createTextNode(text.slice(last)));
  return nodes;
}

class TableWidget extends WidgetType {
  constructor(readonly source: string, readonly onLink: (href: string) => void) { super(); }

  override eq(other: TableWidget): boolean { return other.source === this.source; }

  toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const lines = this.source.split("\n").map((line) => line.replace(/\r$/, ""));
    const header = splitRow(lines[0] ?? "");
    const aligns = splitRow(lines[1] ?? "").map(alignOf);
    const outer = doc.createElement("div");
    outer.className = "cm-ovis-table markdown";
    const wrap = doc.createElement("div");
    wrap.className = "markdown-table-wrap";
    const table = doc.createElement("table");
    const row = (cells: string[], tag: "th" | "td"): HTMLTableRowElement => {
      const tr = doc.createElement("tr");
      header.forEach((_, column) => {
        const cell = doc.createElement(tag);
        const align = aligns[column];
        if (align) cell.style.textAlign = align;
        cell.append(...inlineNodes(cells[column] ?? "", doc));
        tr.append(cell);
      });
      return tr;
    };
    const head = doc.createElement("thead");
    head.append(row(header, "th"));
    const body = doc.createElement("tbody");
    for (const line of lines.slice(2)) if (line.trim() !== "") body.append(row(splitRow(line), "td"));
    table.append(head, body);
    wrap.append(table);
    outer.append(wrap);
    // a link opens; anywhere else in the table puts the caret in it, which shows its markdown
    outer.addEventListener("mousedown", (event) => {
      const link = (event.target as HTMLElement | null)?.closest?.("a[data-href]") as HTMLElement | null;
      event.preventDefault();
      if (link?.dataset.href) { this.onLink(link.dataset.href); return; }
      const at = view.posAtDOM(outer);
      view.dispatch({ selection: { anchor: at } });
      view.focus();
    });
    return outer;
  }

  override ignoreEvent(): boolean { return true; }
}

/** Every table not touched by a selection, as one drawn block over its lines. */
function build(state: EditorState, onLink: (href: string) => void): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  tree.iterate({
    enter(node) {
      if (node.name !== "Table") return;
      const from = state.doc.lineAt(node.from).from;
      const to = state.doc.lineAt(node.to).to;
      const touched = state.selection.ranges.some((range) => range.from <= to && range.to >= from);
      if (!touched) builder.add(from, to, Decoration.replace({ widget: new TableWidget(state.doc.sliceString(from, to), onLink), block: true }));
      return false;
    },
  });
  return builder.finish();
}

/** The live editor's tables: drawn, or raw while the caret is in one. `onLink`: a link pressed in a drawn table. */
export function markdownTables(onLink: (href: string) => void): Extension {
  return StateField.define<DecorationSet>({
    create: (state) => build(state, onLink),
    update(decorations, tr: Transaction) {
      if (tr.docChanged || tr.selection !== undefined || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state, onLink);
      return decorations;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}
