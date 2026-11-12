import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Input } from "@lezer/common";
import type { MarkdownConfig } from "@lezer/markdown";

/** A `---` line opening YAML frontmatter, and the `---` or `...` line closing it. */
const OPEN = /^---\s*$/;
const CLOSE = /^(?:---|\.\.\.)\s*$/;

/**
 * YAML frontmatter as one block of its own, `Frontmatter`, for a document that starts with a `---` line
 * and closes it with another (or `...`). Without it CommonMark reads the opening `---` as a rule and the
 * closing one as the underline of a setext heading, so the live editor would draw the YAML as a big
 * heading under a line. Only the document's very first line can open it; an unclosed block stays markdown.
 */
export const frontmatterSyntax: MarkdownConfig = {
  defineNodes: [{ name: "Frontmatter", block: true }, { name: "FrontmatterMark" }],
  parseBlock: [{
    name: "Frontmatter",
    before: "HorizontalRule",
    parse(cx, line) {
      if (cx.lineStart !== 0 || !OPEN.test(line.text)) return false;
      // look ahead for the closing line before taking anything: no close, no frontmatter
      // BlockContext keeps its input but does not type it; without it, no frontmatter rather than a guess
      const input = (cx as unknown as { input?: Input }).input;
      if (input === undefined) return false;
      const lines = input.read(0, Math.min(input.length, 64 * 1024)).split("\n");
      let closing = -1;
      for (let index = 1; index < lines.length; index++) {
        if (CLOSE.test((lines[index] ?? "").replace(/\r$/, ""))) { closing = index; break; }
      }
      if (closing < 0) return false;
      const start = cx.lineStart;
      const marks = [cx.elt("FrontmatterMark", start, start + line.text.length)];
      for (let index = 0; index < closing; index++) cx.nextLine();
      marks.push(cx.elt("FrontmatterMark", cx.lineStart, cx.lineStart + line.text.length));
      const end = cx.lineStart + line.text.length;
      cx.nextLine();
      cx.addElement(cx.elt("Frontmatter", start, end, marks));
      return true;
    },
  }],
};

/** The frontmatter's line count from the document's start, read straight from the text (no tree needed). */
function frontmatterLines(view: EditorView): number {
  const doc = view.state.doc;
  if (doc.lines < 2 || !OPEN.test(doc.line(1).text)) return 0;
  const last = Math.min(doc.lines, 400);
  for (let number = 2; number <= last; number++) if (CLOSE.test(doc.line(number).text)) return number;
  return 0;
}

const fenceLine = Decoration.line({ class: "cm-ovis-frontmatter cm-ovis-frontmatter-fence" });
const bodyLine = Decoration.line({ class: "cm-ovis-frontmatter" });

function decorate(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const count = frontmatterLines(view);
  for (let number = 1; number <= count; number++) {
    const line = view.state.doc.line(number);
    builder.add(line.from, line.from, number === 1 || number === count ? fenceLine : bodyLine);
  }
  return builder.finish();
}

/** Draws the frontmatter lines as a quiet monospace block, like a code fence. */
export const frontmatterLook: Extension = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = decorate(view); }
  update(update: ViewUpdate) { if (update.docChanged) this.decorations = decorate(update.view); }
}, { decorations: (plugin) => plugin.decorations });
