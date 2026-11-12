import "@atomic-editor/editor/styles.css";
import "./MarkdownLiveEditor.css";

import { atomicEditorTheme, autoCloseCodeFence, extendEmphasisPair, highlightMarkdown, inlinePreview, readOnlyExtension, startAsteriskList } from "@atomic-editor/editor";
import { ATOMIC_CODE_LANGUAGES } from "@atomic-editor/editor/code-languages";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, indentOnInput, LanguageDescription, LanguageSupport, StreamLanguage, syntaxTree } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { indentationMarkers } from "@replit/codemirror-indentation-markers";
import { useEffect, useRef } from "react";

import { frontmatterLook, frontmatterSyntax } from "../lib/markdownFrontmatter.ts";
import { ovisMarkdownSyntax, previewLook } from "../lib/markdownLook.ts";
import type { OutlineEntry } from "../lib/markdownOutline.ts";
import type { OutlineLocator } from "./MarkdownOutline.tsx";
import { markdownTables } from "../lib/markdownTables.ts";

/** C# fences (Unity docs are full of them): not in Atomic's curated list, loaded the first time a fence names it. */
const CSHARP = LanguageDescription.of({
  name: "C#",
  alias: ["csharp", "cs", "c#"],
  extensions: ["cs"],
  load: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).csharp)),
});
const CODE_LANGUAGES = [...ATOMIC_CODE_LANGUAGES, CSHARP];

/**
 * The live preview's editing and drawing, shared by the file viewer's editor and the chat composer's
 * (ComposerLiveEditor.tsx): markdown with its look, tables revealed whole, links handed to `link`.
 */
export function liveMarkdownExtensions(link: (href: string) => void): Extension[] {
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    closeBrackets(),
    startAsteriskList,
    extendEmphasisPair,
    autoCloseCodeFence,
    EditorView.lineWrapping,
    search({ top: true }),
    markdown({ base: markdownLanguage, codeLanguages: CODE_LANGUAGES, extensions: [highlightMarkdown, frontmatterSyntax] }),
    markdownLanguage.data.of({ closeBrackets: { brackets: ["(", "[", "{", "'", "\"", "*", "_", "`"] } }),
    ovisMarkdownSyntax,
    atomicEditorTheme,
    keymap.of([...closeBracketsKeymap, ...historyKeymap, ...searchKeymap, ...markdownKeymap, indentWithTab, ...defaultKeymap]),
    markdownTables(link),
    inlinePreview({ onLinkClick: link }),
    frontmatterLook,
    previewLook,
  ];
}

/** Local: VS Code style indent guides in the file editor's Live edit (not the composer). Colours take the theme's tokens. */
const indentGuides = indentationMarkers({
  thickness: 1,
  colors: { light: "var(--border)", dark: "var(--border)", activeLight: "var(--md-rail)", activeDark: "var(--md-rail)" },
});

/** The live editor's headings for the viewer's outline (MarkdownOutline), and how to find them in the editor. */
export interface LiveOutline {
  entries: OutlineEntry[];
  locate: OutlineLocator;
}

/** A heading's words: its markers and inline formatting dropped, a link by its text. */
function headingWords(line: string): string {
  return line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/\s+#+\s*$/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`~=]/g, "").replace(/\s+/g, " ").trim();
}

/** The document's headings, in order, with where each starts. */
function headingsOf(state: EditorState): { entries: OutlineEntry[]; starts: number[] } {
  const entries: OutlineEntry[] = [];
  const starts: number[] = [];
  const tree = ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  tree.iterate({
    enter(node) {
      const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
      if (match === null) return;
      const text = headingWords(state.doc.lineAt(node.from).text);
      if (text !== "") { entries.push({ level: Number(match[1]) as OutlineEntry["level"], text, at: entries.length }); starts.push(node.from); }
      return false;
    },
  });
  return { entries, starts };
}

/** The nearest box around `element` that scrolls: the editor's own, or the viewer body it grows in. */
function scrollingBox(element: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = element; node !== null; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

export interface MarkdownLiveEditorProps {
  /** names the document: a new one (another file, the file reloaded) starts a new editor */
  documentId: string;
  /** the text the editor opens with; later changes come back through `onChange` only */
  text: string;
  onChange: (text: string) => void;
  readOnly: boolean;
  /** a link pressed in the text: the href as written */
  onLink: (href: string) => void;
  label: string;
  /** the headings for the viewer's outline, again whenever they change; null when the editor goes */
  onOutline?: (outline: LiveOutline | null) => void;
}

/**
 * Obsidian-style live preview over a markdown file's raw text, on CodeMirror 6 with Atomic Editor's
 * inline preview: the line under the caret shows its markdown, every other line shows drawn. Atomic's
 * own component is not used: its tables are edited cell by cell, where here (as in Obsidian's source
 * reveal) a table turns into its markdown while the caret is in it (lib/markdownTables.ts), and its
 * language takes no frontmatter. Every decoration is view-only, so the text saved is the text typed.
 */
export default function MarkdownLiveEditor({ documentId, text, onChange, readOnly, onLink, label, onOutline }: MarkdownLiveEditorProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const readOnlyPart = useRef(new Compartment());
  // the callbacks change with every render; the editor, made once per document, reads the latest
  const latest = useRef({ onChange, onLink, readOnly, onOutline });
  latest.current = { onChange, onLink, readOnly, onOutline };

  useEffect(() => {
    if (root.current === null) return;
    const link = (href: string): void => latest.current.onLink(href);
    // the outline's headings, read again a moment after the text or its parse changes
    let starts: number[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (editor: EditorView): void => {
      const found = headingsOf(editor.state);
      starts = found.starts;
      latest.current.onOutline?.({
        entries: found.entries,
        locate: {
          scroller: () => scrollingBox(editor.scrollDOM),
          tops: () => starts.map((at) => editor.documentTop + editor.lineBlockAt(Math.min(at, editor.state.doc.length)).top),
          jump: (entry) => {
            const at = starts[entry.at];
            if (at !== undefined) editor.dispatch({ effects: EditorView.scrollIntoView(at, { y: "start", yMargin: 8 }) });
          },
        },
      });
    };
    const later = (editor: EditorView): void => { clearTimeout(timer); timer = setTimeout(() => report(editor), 150); };
    const editor = new EditorView({
      parent: root.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          ...liveMarkdownExtensions(link),
          indentGuides,
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
          readOnlyPart.current.of(readOnlyExtension(latest.current.readOnly)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString());
            if (update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) later(update.view);
          }),
        ],
      }),
    });
    view.current = editor;
    report(editor);
    return () => { clearTimeout(timer); editor.destroy(); view.current = null; latest.current.onOutline?.(null); };
    // one editor per document: `text` is only its opening text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnlyPart.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  // `file-viewer-content`: the Preview's text size, from Settings > File text size (ChatView.css)
  return <div className="file-live-editor file-viewer-content"><div ref={root} className="atomic-cm-editor" /></div>;
}
