import { describe, expect, test } from "bun:test";

import { locate, locateInTexts, loose, segment, toSpeech, wordAt, wordSpanInTexts } from "./readAloud.ts";

describe("toSpeech", () => {
  test("keeps link text, drops urls, code marks and emphasis", () => {
    expect(toSpeech("See [the docs](https://x.y/z) for **bold** `code` at https://a.b")).toBe("See the docs for bold code at");
  });
  test("reads table pipes as pauses and drops list markers", () => {
    expect(toSpeech("| a | b |")).toBe(", a , b ,");
    expect(toSpeech("- item one")).toBe("item one");
    expect(toSpeech("12. step")).toBe("step");
  });
});

describe("segment", () => {
  test("splits sentences, skips code blocks and table rules, keeps bold", () => {
    const md = "First **bold** one. Second one!\n\n```ts\nconst a = 1. 2;\n```\n\n| h | i |\n|---|---|\n| yes | no |\n\n- last item";
    const out = segment(md);
    expect(out.map((s) => s.speech)).toEqual(["First bold one.", "Second one!", ", h , i ,", ", yes , no ,", "last item"]);
    expect(out[0]!.raw).toBe("First **bold** one.");
  });
  test("an unclosed code fence swallows the rest instead of being read", () => {
    expect(segment("Hi there.\n\n```js\nlet a = 1;").map((s) => s.speech)).toEqual(["Hi there."]);
  });
  test("long text ends with one line saying the rest is on screen", () => {
    const out = segment("One two three. Four five six.", 20);
    expect(out.at(-1)).toEqual({ raw: "", speech: "The rest is on screen." });
  });
  test("lines with no word characters are skipped", () => {
    expect(segment("---\n\n***\n\nReal words.").map((s) => s.speech)).toEqual(["Real words."]);
  });
});

describe("wordAt", () => {
  test("walks the words as time passes", () => {
    const raw = "aaaa bbbb cccc dddd";
    expect(wordAt(raw, 0, 1000)).toBe(0);
    expect(wordAt(raw, 500, 1000)).toBe(1);
    expect(wordAt(raw, 1000, 1000)).toBe(3);
    expect(wordAt(raw, 5000, 1000)).toBe(3);
  });
  test("empty text is word zero", () => {
    expect(wordAt("", 10, 100)).toBe(0);
  });
});

describe("loose and locate", () => {
  test("loose drops whitespace and markup and maps back", () => {
    const { flat, map } = loose("a *b*\n c");
    expect(flat).toBe("abc");
    expect(map).toEqual([0, 3, 7]);
  });
  test("locates markdown in rendered text", () => {
    const rendered = "Intro line.\nFirst bold one. Second one!";
    const span = locate(rendered, "First **bold** one.");
    expect(span).not.toBeNull();
    expect(rendered.slice(span![0], span![1])).toBe("First bold one.");
  });
  test("earlier sentences pick the right copy of a repeated phrase", () => {
    const rendered = "Yes. No. Yes.";
    expect(locate(rendered, "Yes.")).toEqual([0, 4]);
    expect(locate(rendered, "Yes.", ["Yes.", "No."])).toEqual([9, 13]);
  });
  test("a missing sentence is null", () => {
    expect(locate("nothing here", "absent words")).toBeNull();
  });
});

describe("locateInTexts", () => {
  const texts = ["Intro ", "First ", "bold", " one.", " Second one!"];
  test("spans text nodes, as rendered markdown is split by elements", () => {
    expect(locateInTexts(texts, "First **bold** one.")).toEqual({ startNode: 1, startOffset: 0, endNode: 3, endOffset: 5 });
  });
  test("finds a table row across cells", () => {
    expect(locateInTexts(["h", "i", "yes", "no"], "| yes | no |")).toEqual({ startNode: 2, startOffset: 0, endNode: 3, endOffset: 2 });
  });
  test("the current word lands inside the sentence", () => {
    const sentence = locateInTexts(texts, "First **bold** one.")!;
    expect(wordSpanInTexts(texts, sentence, "First **bold** one.", 1)).toEqual({ startNode: 2, startOffset: 0, endNode: 2, endOffset: 4 });
  });
});
