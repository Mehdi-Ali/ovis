import "@atomic-editor/editor/styles.css";
import "./MarkdownLiveEditor.css";

import { insertNewlineContinueMarkup } from "@codemirror/lang-markdown";
import { Compartment, EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderText } from "@codemirror/view";
import { useEffect, useRef } from "react";

import { liveMarkdownExtensions } from "./MarkdownLiveEditor.tsx";

/** The parts of a key press the composer's own key handling reads (Composer.tsx onKeyDown). */
export interface ComposerKey {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  nativeEvent: KeyboardEvent;
  preventDefault: () => void;
}

export interface ComposerLiveEditorProps {
  /** the draft: typed text comes back through `onText`; a change made elsewhere (a pick, a send, a restore) replaces the editor's */
  text: string;
  /** where the caret goes when the text is replaced from outside */
  caret: number;
  placeholder: string;
  label: string;
  autoFocus: boolean;
  onText: (text: string, caret: number) => void;
  onCaret: (caret: number) => void;
  /** every key press, before the editor's own keys: the composer sends, picks from its menu, stops */
  onKey: (key: ComposerKey) => void;
  onLink: (href: string) => void;
}

/**
 * The chat composer's message box as Obsidian-style live preview (Settings > Chat > Live edit
 * message box): the same CodeMirror composition as the file viewer's Live edit, sized like the
 * plain box. The text is the draft as typed; nothing the preview draws is sent.
 */
export default function ComposerLiveEditor({ text, caret, placeholder, label, autoFocus, onText, onCaret, onKey, onLink }: ComposerLiveEditorProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  // the placeholder changes with suggestions and hints: swapped in place, never a new editor
  const placeholderPart = useRef(new Compartment());
  const latest = useRef({ onText, onCaret, onKey, onLink, caret });
  latest.current = { onText, onCaret, onKey, onLink, caret };

  useEffect(() => {
    if (root.current === null) return;
    const editor = new EditorView({
      parent: root.current,
      state: EditorState.create({
        doc: text,
        selection: EditorSelection.cursor(Math.min(caret, text.length)),
        extensions: [
          // the composer's keys first: Enter sends, arrows move through its menu, Escape stops
          Prec.highest(EditorView.domEventHandlers({
            keydown(event) {
              latest.current.onKey({
                key: event.key, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
                repeat: event.repeat, nativeEvent: event, preventDefault: () => event.preventDefault(),
              });
              return event.defaultPrevented;
            },
          })),
          // a line break that the composer left alone keeps a list going, as Enter does in the file's Live edit
          Prec.high(keymap.of([{ key: "Shift-Enter", run: insertNewlineContinueMarkup }])),
          ...liveMarkdownExtensions((href) => latest.current.onLink(href)),
          placeholderPart.current.of(placeholderText(placeholder)),
          // prose to an agent: the phone's corrections and capitals stay on, as in the plain box
          EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "true", autocapitalize: "sentences", autocorrect: "on" }),
          EditorView.updateListener.of((update) => {
            const head = update.state.selection.main.head;
            if (update.docChanged) latest.current.onText(update.state.doc.toString(), head);
            else if (update.selectionSet) latest.current.onCaret(head);
          }),
        ],
      }),
    });
    view.current = editor;
    if (autoFocus) editor.focus();
    return () => { editor.destroy(); view.current = null; };
    // one editor for the composer's life: text and caret after this come through the effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);

  useEffect(() => {
    view.current?.dispatch({ effects: placeholderPart.current.reconfigure(placeholderText(placeholder)) });
  }, [placeholder]);

  // the draft changed outside the editor (a menu pick, a send clearing it, another tab): take it whole
  useEffect(() => {
    const editor = view.current;
    if (editor === null) return;
    const current = editor.state.doc.toString();
    if (current === text) return;
    const at = Math.min(latest.current.caret, text.length);
    editor.dispatch({ changes: { from: 0, to: current.length, insert: text }, selection: EditorSelection.cursor(at) });
  }, [text]);

  return <div className="file-live-editor composer-live"><div ref={root} className="atomic-cm-editor" /></div>;
}
