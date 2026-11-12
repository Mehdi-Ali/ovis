import "@atomic-editor/editor/styles.css";
import "./MarkdownLiveEditor.css";

import { AtomicCodeMirrorEditor, highlightMarkdown } from "@atomic-editor/editor";
import { ATOMIC_CODE_LANGUAGES } from "@atomic-editor/editor/code-languages";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { useMemo, useState } from "react";

import { frontmatterLook, frontmatterSyntax } from "../lib/markdownFrontmatter.ts";

/** C# fences (Unity docs are full of them): not in Atomic's curated list, loaded the first time a fence names it. */
const CSHARP = LanguageDescription.of({
  name: "C#",
  alias: ["csharp", "cs", "c#"],
  extensions: ["cs"],
  load: async () => new LanguageSupport(StreamLanguage.define((await import("@codemirror/legacy-modes/mode/clike")).csharp)),
});
const CODE_LANGUAGES = [...ATOMIC_CODE_LANGUAGES, CSHARP];

/**
 * The editor's markdown language again, with frontmatter added. Atomic builds its own `markdown()` with no
 * way to add a block parser, so this one sits above it (`Prec.highest`, the language facet takes the first):
 * the same GFM base, Atomic's own inline syntax and fences, plus the frontmatter block.
 */
const LANGUAGE = [
  Prec.highest(markdown({ base: markdownLanguage, codeLanguages: CODE_LANGUAGES, extensions: [highlightMarkdown, frontmatterSyntax] })),
  frontmatterLook,
];

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
 * Obsidian-style live preview over a markdown file's raw text (Atomic Editor on CodeMirror 6): the line
 * under the caret shows its markdown, every other line shows drawn. Every decoration is view-only, so
 * the text saved is exactly the text typed, byte for byte.
 */
export default function MarkdownLiveEditor({ documentId, text, onChange, readOnly, onLink, label }: MarkdownLiveEditorProps) {
  // Atomic remounts on a new source when no id is given; the opening text is read once per document
  const [opening] = useState(text);
  const extensions = useMemo(() => LANGUAGE, []);
  return <div className="file-live-editor" aria-label={label}>
    <AtomicCodeMirrorEditor key={documentId} documentId={documentId} markdownSource={opening} onMarkdownChange={onChange}
      readOnly={readOnly} onLinkClick={onLink} extensions={extensions} />
  </div>;
}
