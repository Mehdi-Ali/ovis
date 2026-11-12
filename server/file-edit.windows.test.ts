import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEditableText, saveEditableText, TextEditRefused } from "./file-edit.ts";

const sha = (text: string): string => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** Saving from the file viewer on Windows: the same revision check and atomic replace as elsewhere. */
describe.skipIf(process.platform !== "win32")("editing a text file on Windows", () => {
  let pane: string;
  beforeEach(() => { pane = mkdtempSync(join(tmpdir(), "ovis-edit-win-")); mkdirSync(join(pane, "docs")); });
  afterEach(() => rmSync(pane, { recursive: true, force: true }));

  it("saves over a file that still has the revision read, keeping CRLF endings", () => {
    const note = join(pane, "docs", "note.md");
    writeFileSync(note, "---\r\nstatus: draft\r\n---\r\n# A\r\n");
    const opened = readEditableText("docs/note.md", pane);
    expect(opened.line_endings).toBe("crlf");
    const saved = saveEditableText("docs/note.md", pane, opened.revision, "---\nstatus: shipped\n---\n# A\n");
    expect(readFileSync(note, "utf8")).toBe("---\r\nstatus: shipped\r\n---\r\n# A\r\n");
    expect(saved.revision).toBe(sha("---\r\nstatus: shipped\r\n---\r\n# A\r\n"));
    expect(readdirSync(join(pane, "docs"))).toEqual(["note.md"]);
  });

  it("refuses a file changed since it was read, and writes nothing", () => {
    const note = join(pane, "note.md");
    writeFileSync(note, "one\n");
    const opened = readEditableText("note.md", pane);
    writeFileSync(note, "agent\n");
    expect(() => saveEditableText("note.md", pane, opened.revision, "mine\n")).toThrow(TextEditRefused);
    expect(readFileSync(note, "utf8")).toBe("agent\n");
    expect(readdirSync(pane).sort()).toEqual(["docs", "note.md"]);
  });

  it("refuses a file outside the pane's folder", () => {
    const outside = mkdtempSync(join(tmpdir(), "ovis-edit-out-"));
    try {
      writeFileSync(join(outside, "x.md"), "x\n");
      expect(() => readEditableText(join(outside, "x.md"), pane)).toThrow(TextEditRefused);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
