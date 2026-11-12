import "@atomic-editor/editor/styles.css";
import "./MarkdownLiveEditor.css";

import { atomicEditorTheme, atomicMarkdownSyntax, autoCloseCodeFence, extendEmphasisPair, highlightMarkdown, inlinePreview, readOnlyExtension, startAsteriskList } from "@atomic-editor/editor";
import { ATOMIC_CODE_LANGUAGES } from "@atomic-editor/editor/code-languages";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { indentOnInput, LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { drawSelection, dropCursor, EditorView, highlightSpecialChars, keymap } from "@codemirror/view";
import { useEffect, useRef } from "react";

import { frontmatterLook, frontmatterSyntax } from "../lib/markdownFrontmatter.ts";
import { markdownTables } from "../lib/markdownTables.ts";

/** C# fences (Unity docs are full of them): not in Atomic's curated list, loaded the first time a fence names it. */
const CSHARP = LanguageDescription.of({
  name: "C#",
  alias: ["csharp", "cs", "c#"],
  extensions: ["cs"],
  load: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).csharp)),
});
const CODE_LANGUAGES = [...ATOMIC_CODE_LANGUAGES, CSHARP];

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
}

/**
 * Obsidian-style live preview over a markdown file's raw text, on CodeMirror 6 with Atomic Editor's
 * inline preview: the line under the caret shows its markdown, every other line shows drawn. Atomic's
 * own component is not used: its tables are edited cell by cell, where here (as in Obsidian's source
 * reveal) a table turns into its markdown while the caret is in it (lib/markdownTables.ts), and its
 * language takes no frontmatter. Every decoration is view-only, so the text saved is the text typed.
 */
export default function MarkdownLiveEditor({ documentId, text, onChange, readOnly, onLink, label }: MarkdownLiveEditorProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const readOnlyPart = useRef(new Compartment());
  // the callbacks change with every render; the editor, made once per document, reads the latest
  const latest = useRef({ onChange, onLink, readOnly });
  latest.current = { onChange, onLink, readOnly };

  useEffect(() => {
    if (root.current === null) return;
    const link = (href: string): void => latest.current.onLink(href);
    const editor = new EditorView({
      parent: root.current,
      state: EditorState.create({
        doc: text,
        extensions: [
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
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false", autocapitalize: "off", autocorrect: "off" }),
          search({ top: true }),
          markdown({ base: markdownLanguage, codeLanguages: CODE_LANGUAGES, extensions: [highlightMarkdown, frontmatterSyntax] }),
          markdownLanguage.data.of({ closeBrackets: { brackets: ["(", "[", "{", "'", "\"", "*", "_", "`"] } }),
          atomicMarkdownSyntax,
          atomicEditorTheme,
          keymap.of([...closeBracketsKeymap, ...historyKeymap, ...searchKeymap, ...markdownKeymap, indentWithTab, ...defaultKeymap]),
          markdownTables(link),
          inlinePreview({ onLinkClick: link }),
          frontmatterLook,
          readOnlyPart.current.of(readOnlyExtension(latest.current.readOnly)),
          EditorView.updateListener.of((update) => { if (update.docChanged) latest.current.onChange(update.state.doc.toString()); }),
        ],
      }),
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
    // one editor per document: `text` is only its opening text
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  useEffect(() => {
    view.current?.dispatch({ effects: readOnlyPart.current.reconfigure(readOnlyExtension(readOnly)) });
  }, [readOnly]);

  return <div className="file-live-editor"><div ref={root} className="atomic-cm-editor" /></div>;
}
