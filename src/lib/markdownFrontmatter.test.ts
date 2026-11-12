import { describe, expect, test } from "bun:test";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownParser } from "@lezer/markdown";

import { joinFilePath } from "./joinFilePath.ts";
import { frontmatterSyntax } from "./markdownFrontmatter.ts";

const parser = (markdownLanguage.parser as MarkdownParser).configure([frontmatterSyntax]);
/** the top-level block names of `text`, in order */
const blocks = (text: string): string[] => {
  const names: string[] = [];
  const cursor = parser.parse(text).cursor();
  if (cursor.firstChild()) do names.push(cursor.name); while (cursor.nextSibling());
  return names;
};

describe("frontmatter", () => {
  test("a closed block at the start is one Frontmatter, not a rule and a setext heading", () => {
    expect(blocks("---\nstatus: draft\ntags: [a]\n---\n\n# Title\n")).toEqual(["Frontmatter", "ATXHeading1"]);
    expect(blocks("---\r\nstatus: draft\r\n---\r\n\r\ntext\r\n")).toEqual(["Frontmatter", "Paragraph"]);
    expect(blocks("---\nstatus: draft\n...\nbody\n")).toEqual(["Frontmatter", "Paragraph"]);
  });

  test("an unclosed opening line, or one not on the first line, stays markdown", () => {
    expect(blocks("---\nnot closed\n")).not.toContain("Frontmatter");
    expect(blocks("intro\n\n---\nstatus: x\n---\n")).not.toContain("Frontmatter");
  });
});

describe("joinFilePath", () => {
  test("resolves a link from the file's folder", () => {
    expect(joinFilePath("C:/vault/_Docs/a.md", "b.md")).toBe("C:/vault/_Docs/b.md");
    expect(joinFilePath("C:\\vault\\_Docs\\a.md", "../_Tasks/x/notes.md")).toBe("C:/vault/_Tasks/x/notes.md");
    expect(joinFilePath("/home/u/docs/a.md", "./sub/c.md")).toBe("/home/u/docs/sub/c.md");
  });

  test("keeps an absolute or home path as written", () => {
    expect(joinFilePath("C:/vault/a.md", "D:/other/b.md")).toBe("D:/other/b.md");
    expect(joinFilePath("C:/vault/a.md", "~/notes.md")).toBe("~/notes.md");
  });
});
