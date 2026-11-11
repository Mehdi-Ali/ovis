import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gjcBoxAnsi, gjcInputDraft, parseGjcSuggestion, parseOmpSuggestion } from "./omp-input.ts";

const fg = (r: number, g: number, b: number) => `\u001b[38;2;${r};${g};${b}m`;
const RESET = "\u001b[0m";
const plain = (ansi: string) => ansi.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").map((line) => line.replace(/\r$/, "").trimEnd()).join("\n");

describe("gjc's input box holding a draft (#3627)", () => {
  // gjc 0.18.12 in an owned herdr pane at 120 columns: the last rows of `pane.read` (detection text, visible ansi)
  const real = JSON.parse(readFileSync(new URL("./fixtures/gjc-input-0.18.12-rows.json", import.meta.url), "utf8")) as Record<"empty" | "draft" | "draft-wrapped", { text: string; ansi: string }>;

  test("reads gjc's own placeholder as empty, and typed text, one row or wrapped, as a draft", () => {
    expect(gjcInputDraft(real.empty.text, real.empty.ansi)).toBeFalse();
    expect(gjcInputDraft(real.draft.text, real.draft.ansi)).toBeTrue();
    expect(gjcInputDraft(real["draft-wrapped"].text, real["draft-wrapped"].ansi)).toBeTrue();
  });

  test("without a verified color read, anything in the box holds the send, the placeholder too", () => {
    // only the styling tells the placeholder from the same words typed: the safer miss is a refusal
    expect(gjcInputDraft(real.empty.text, null)).toBeTrue();
    expect(gjcInputDraft(real.draft.text, null)).toBeTrue();
    // colors of another screen (the viewport scrolled) prove nothing
    expect(gjcInputDraft(real.empty.text, real.draft.ansi)).toBeTrue();
  });

  test("a draft typed with the placeholder's own words is a draft", () => {
    const typed = real.draft.ansi.replace("a draft typed in the terminal", "Type your message to the team");
    expect(gjcInputDraft(plain(typed), typed)).toBeTrue();
    expect(gjcInputDraft(plain(typed), null)).toBeTrue();
  });

  test("the placeholder after gjc's own cursor, or cut short, is empty with its colors", () => {
    const cursor = real.empty.ansi.replace("\u001b[0m \u001b[0m\u001b[38;2;111;71;67mType", "\u001b[0m \u001b[5m▏\u001b[0m\u001b[38;2;111;71;67mType");
    expect(cursor).not.toBe(real.empty.ansi);
    expect(gjcInputDraft(plain(cursor), cursor)).toBeFalse();
    expect(gjcInputDraft(plain(box(`${DIM}Type your mes…${RESET}`)), box(`${DIM}Type your mes…${RESET}`))).toBeFalse();
  });

  test("names the box as its colored read draws it, so two reads can be compared", () => {
    expect(gjcBoxAnsi(real.empty.ansi)).toContain("Type your message");
    expect(gjcBoxAnsi(real.empty.ansi)).not.toBe(gjcBoxAnsi(real.draft.ansi));
    expect(gjcBoxAnsi("no box here")).toBeNull();
  });

  const BORDER = fg(255, 106, 61);
  const DIM = fg(111, 71, 67);
  const box = (input: string, top = `╭${"─".repeat(44)}╮`, bottom = `╰${"─".repeat(44)}╯`) => {
    const shown = input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    return ["earlier output", `${RESET}${BORDER}${top}${RESET} `, `${RESET}${BORDER}${top[0] === "+" ? "|" : "│"} >${RESET} ${input}${" ".repeat(Math.max(0, 40 - shown.length))}${RESET}${BORDER} ${top[0] === "+" ? "|" : "│"}${RESET} `, `${RESET}${BORDER}${bottom}${RESET} `].join("\r\n");
  };
  const draft = (input: string) => gjcInputDraft(plain(box(input)), box(input));

  test("gjc's suggestion, its microphone and its cursor are not typed", () => {
    expect(draft(`${DIM}run the tests again${RESET}`)).toBeFalse();
    expect(draft(`\u001b[5m▏${RESET}${DIM}run the tests again${RESET}`)).toBeFalse();
    expect(draft(`${fg(200, 40, 40)}🎤${RESET}`)).toBeFalse();
    expect(draft("")).toBeFalse();
  });

  test("anything drawn in the terminal's own color is typed, a suggestion after it or not", () => {
    expect(draft("hello")).toBeTrue();
    expect(draft(`hello ${DIM}there${RESET}`)).toBeTrue();
    expect(draft("Type your message")).toBeTrue();
    expect(gjcInputDraft(plain(box("x", `+${"-".repeat(44)}+`, `+${"-".repeat(44)}+`)), box("x", `+${"-".repeat(44)}+`, `+${"-".repeat(44)}+`))).toBeTrue();
  });

  test("a screen without gjc's box is left to the send", () => {
    expect(gjcInputDraft("Select a model\n> gpt-6-astra\n  opus-5.5", null)).toBeFalse();
  });
});

describe("gjc's suggested next prompt", () => {
  // gjc 0.20.0 as herdr reads it with ANSI at 120 columns: its box (red-claw theme) ends the screen
  const BORDER = fg(255, 59, 48);
  const DIM = fg(111, 71, 67);
  const top = `${RESET}${BORDER}╭${"─".repeat(116)}╮${RESET} `;
  const bottom = `${RESET}${BORDER}╰${"─".repeat(116)}╯${RESET} `;
  const row = (input: string, width = 40) => {
    const shown = input.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
    return `${RESET}${BORDER}│ ${RESET}${fg(255, 106, 61)}>${RESET} ${input}${" ".repeat(Math.max(0, width - shown.length))}${RESET}${BORDER} │${RESET} `;
  };
  const ghost = (text: string) => `${RESET}${DIM}${text}${RESET}`;
  const screen = (...box: string[]) => [
    " 다 끝났습니다. 테스트도 모두 통과했어요.",
    "",
    `${RESET}${fg(255, 231, 220)}\u001b[48;2;42;21;21m ${RESET}${fg(255, 106, 61)}\u001b[48;2;42;21;21m⬢ opus-5.5 · ◕ high · ${RESET}${fg(125, 211, 199)}\u001b[48;2;42;21;21m3.4%${RESET}`,
    ...box,
    "",
  ].join("\r\n");

  test("reads the ghost text in the empty box", () => {
    expect(parseGjcSuggestion(screen(top, row(ghost("커밋하고 PR 올려줘")), bottom))).toBe("커밋하고 PR 올려줘");
    expect(parseGjcSuggestion(screen(top, row(ghost("run the tests again")), bottom))).toBe("run the tests again");
    // the ascii symbol preset draws the box in `+-|`
    const ascii = (input: string) => row(input).replace("│ ", "| ").replace(" │", " |");
    expect(parseGjcSuggestion(screen(`+${"-".repeat(116)}+`, ascii(ghost("run the tests again")), `+${"-".repeat(116)}+`))).toBe("run the tests again");
  });

  test("past gjc's own cursor, drawn when the hardware cursor is off", () => {
    expect(parseGjcSuggestion(screen(top, row(`\u001b[5m▏${RESET}${ghost("run the tests again")}`), bottom))).toBe("run the tests again");
  });

  test("nothing while text is typed, for the placeholder, or for an empty box", () => {
    // typed text takes the terminal's own color
    expect(parseGjcSuggestion(screen(top, row("hello typed text"), bottom))).toBeNull();
    expect(parseGjcSuggestion(screen(top, row(`hello ${ghost("typed text")}`), bottom))).toBeNull();
    expect(parseGjcSuggestion(screen(top, row(ghost("Type your message... ⌥↩: Queue (busy) · ⌃C: Clear")), bottom))).toBeNull();
    expect(parseGjcSuggestion(screen(top, row(""), bottom))).toBeNull();
  });

  test("nothing for a colored glyph alone: gjc's microphone while it records speech is no prompt", () => {
    // gjc draws its speech-to-text cursor as the theme's mic icon in a color of its own, by itself in the empty box
    expect(parseGjcSuggestion(screen(top, row(`${fg(200, 40, 40)}🎤${RESET}`), bottom))).toBeNull();
    expect(parseGjcSuggestion(screen(top, row(ghost("●")), bottom))).toBeNull();
    // a suggestion of one word, or of digits alone, is still one
    expect(parseGjcSuggestion(screen(top, row(ghost("계속")), bottom))).toBe("계속");
    expect(parseGjcSuggestion(screen(top, row(ghost("2")), bottom))).toBe("2");
  });

  test("nothing for a suggestion cut short at the box's edge: only part of it would go into the box", () => {
    expect(parseGjcSuggestion(screen(top, row(ghost("공통 규칙이랑 화면 줄 수정 커밋하고, 새 강의 몇 개로 한 번씩만 돌려서 원…")), bottom))).toBeNull();
  });

  test("only the box that ends the screen, with one row", () => {
    expect(parseGjcSuggestion(screen(top, row(ghost("first row")), row(ghost("second row")), bottom))).toBeNull();
    // an autocomplete list under the box
    expect(parseGjcSuggestion(screen(top, row(ghost("run the tests")), bottom, "  /review  Review the changes"))).toBeNull();
    expect(parseGjcSuggestion(screen(row(ghost("run the tests")), bottom))).toBeNull();
    // a border drawn in the ghost's color after a different row is no box
    expect(parseGjcSuggestion(screen(top, ghost("│ > run the tests │"), bottom))).toBeNull();
  });
  test("a suggestion with a character outside the BMP", () => {
    expect(parseGjcSuggestion(screen(top, row(ghost("🚀 ship it, 𠮷野家 다음")), bottom))).toBe("🚀 ship it, 𠮷野家 다음");
  });

  test("a typed `|` or `▏` is no cursor: it does not blink", () => {
    expect(parseGjcSuggestion(screen(top, row(`|${ghost("continue")}`), bottom))).toBeNull();
    expect(parseGjcSuggestion(screen(top, row(`▏${ghost("continue")}`), bottom))).toBeNull();
    // a suggestion's own `▏` is part of it
    expect(parseGjcSuggestion(screen(top, row(ghost("▏continue")), bottom))).toBe("▏continue");
  });

  test("colors in their colon form, and a background whose channels look like codes", () => {
    expect(parseGjcSuggestion(screen(top, row(`\u001b[38:2::111:71:67mrun the tests${RESET}`), bottom))).toBe("run the tests");
    // 48 with the channels 7 and 2: no inverse, no dim, typed text stays typed
    expect(parseGjcSuggestion(screen(top, row(`\u001b[48:2::0:7:2mhello typed${RESET}`), bottom))).toBeNull();
    expect(parseGjcSuggestion(screen(top, row(`\u001b[48;2;0;7;2mhello typed${RESET}`), bottom))).toBeNull();
  });
});

describe("omp's predicted next prompt", () => {
  // omp 18.18.3 as herdr reads it with ANSI at 120 columns, in the default band composer
  const status = ` ${fg(107, 114, 128)}π${RESET} ${fg(42, 48, 56)}>${RESET} ${fg(0, 180, 255)}◒ GPT-6.1 Sol${RESET} ${fg(42, 48, 56)}>${RESET} ${fg(0, 180, 255)}─2%${RESET}${fg(42, 48, 56)}${"─".repeat(40)}${RESET}`;
  const band = (input: string) => `${RESET}${fg(0, 180, 255)}╰─ ${RESET}${input}${" ".repeat(60)}`;
  const DARK_DIM = fg(95, 102, 115);
  const LIGHT_DIM = fg(118, 118, 118);
  const screen = (...composer: string[]) => [
    " Done: the tests pass and the branch is pushed.",
    "",
    ...composer,
    "",
  ].join("\r\n");

  test("reads the prediction in the empty composer, over a dark or a light background", () => {
    expect(parseOmpSuggestion(screen(status, band(`${DARK_DIM}open the PR${RESET}`)))).toBe("open the PR");
    expect(parseOmpSuggestion(screen(status, band(`${LIGHT_DIM}그럼 다음 단계는 뭐야?${RESET}`)))).toBe("그럼 다음 단계는 뭐야?");
    // a theme's 256-color dim
    expect(parseOmpSuggestion(screen(status, band(`\u001b[38;5;242mopen the PR${RESET}`)))).toBe("open the PR");
    // with no status band, an empty row stands in its place
    expect(parseOmpSuggestion(screen("", band(`${DARK_DIM}open the PR${RESET}`)))).toBe("open the PR");
  });

  test("past omp's own cursor, drawn steady when the hardware cursor is off", () => {
    // omp 18.18 draws `▏` without blink, in the terminal's own color; Vim's normal mode an inverse blank
    expect(parseOmpSuggestion(screen(status, band(`▏${DARK_DIM}open the PR${RESET}`)))).toBe("open the PR");
    expect(parseOmpSuggestion(screen(status, band(`\u001b[7m \u001b[0m${DARK_DIM}open the PR${RESET}`)))).toBe("open the PR");
    // the ascii preset's steady `|` reads as a typed one: no prediction past it
    expect(parseOmpSuggestion(screen(status, band(`|${DARK_DIM}open the PR${RESET}`)))).toBeNull();
  });

  test("in the other composer shapes", () => {
    const rule = `${fg(61, 66, 74)}${"─".repeat(118)}${RESET}`;
    // box: the status in the top border, the prompt merged into the bottom one
    expect(parseOmpSuggestion(screen(`${fg(61, 66, 74)}╭─ π > GPT-6.1 Sol ${"─".repeat(90)}╮${RESET}`, `${fg(61, 66, 74)}╰─ ${RESET}${DARK_DIM}open the PR${RESET}${" ".repeat(80)}${fg(61, 66, 74)}─╯${RESET}`))).toBe("open the PR");
    // claude: the prompt between rules, then the status
    expect(parseOmpSuggestion(screen(rule, `${fg(0, 180, 255)}❯ ${RESET}${DARK_DIM}open the PR${RESET}`, rule, status))).toBe("open the PR");
    // pi: the prompt row has no gutter at all
    expect(parseOmpSuggestion(screen(rule, `${DARK_DIM}open the PR${RESET}`, rule, status))).toBe("open the PR");
  });

  test("nothing while text is typed: omp paints it in its contrast-safe fallback for the theme's text", () => {
    expect(parseOmpSuggestion(screen(status, band(`${fg(229, 229, 231)}hello typed text${RESET}`)))).toBeNull();
    expect(parseOmpSuggestion(screen(status, band(`${fg(0, 0, 0)}hello typed text${RESET}`)))).toBeNull();
    expect(parseOmpSuggestion(screen(status, band(`\u001b[38;5;254mhello typed text${RESET}`)))).toBeNull();
    expect(parseOmpSuggestion(screen(status, band("hello typed text")))).toBeNull();
    // a prediction shows its rest after a typed prefix of it: that is a draft, not a suggestion
    expect(parseOmpSuggestion(screen(status, band(`${fg(229, 229, 231)}open ${RESET}${DARK_DIM}the PR${RESET}`)))).toBeNull();
  });

  test("nothing for the empty composer's right-aligned hint, or an empty composer", () => {
    expect(parseOmpSuggestion(screen(status, band(`${" ".repeat(70)}${fg(0, 180, 255)}⇧⇥${RESET} ${DARK_DIM}effort${RESET}`)))).toBeNull();
    expect(parseOmpSuggestion(screen(status, band("")))).toBeNull();
  });

  test("nothing for a prediction cut short at the row's edge", () => {
    expect(parseOmpSuggestion(screen(status, band(`${DARK_DIM}update the changelog, then open the PR and ask for a rev…${RESET}`)))).toBeNull();
  });

  test("nothing for typed text in a theme's own text color, a named color, or a custom theme's color", () => {
    // dark-poimandres sets text #a6accd; the 16 named colors are the terminal's to pick
    expect(parseOmpSuggestion(screen(status, band(`${fg(166, 172, 205)}hello typed text${RESET}`)))).toBeNull();
    expect(parseOmpSuggestion(screen(status, band(`${fg(205, 214, 244)}hello typed text${RESET}`)))).toBeNull();
    expect(parseOmpSuggestion(screen(status, band(`\u001b[90mhello typed text${RESET}`)))).toBeNull();
    // light-poimandres types in #506477, another theme's dim; a skill reads in an accent, as #7e57c2 is one
    expect(parseOmpSuggestion(screen(status, band(`${fg(80, 100, 119)}hello typed text${RESET}`)))).toBeNull();
    expect(parseOmpSuggestion(screen(status, band(`\u001b[1m${fg(126, 87, 194)}/skill:review${RESET}`)))).toBeNull();
    // a 256-color cell a theme's accent also maps to
    expect(parseOmpSuggestion(screen(status, band(`\u001b[38;5;60mhello typed text${RESET}`)))).toBeNull();
  });

  test("nothing for a queue draft's header, drawn in the same dim over the draft's blank first row", () => {
    expect(parseOmpSuggestion(screen(status, band(`${DARK_DIM}Queueing ➤${RESET}`), "   "))).toBeNull();
    expect(parseOmpSuggestion(screen(status, band(`${DARK_DIM}Queueing \u{f054}${RESET}`)))).toBeNull();
  });

  test("a prediction with a character outside the BMP", () => {
    expect(parseOmpSuggestion(screen(status, band(`${DARK_DIM}🚀 ship it, 𠮷野家 다음${RESET}`)))).toBe("🚀 ship it, 𠮷野家 다음");
  });

  test("a typed `|` or `▏` is no cursor: omp paints it in its text color", () => {
    expect(parseOmpSuggestion(screen(status, band(`${fg(229, 229, 231)}|${RESET}${DARK_DIM}continue${RESET}`)))).toBeNull();
    // the rest of a prediction after its typed first character, and typed text that goes on
    expect(parseOmpSuggestion(screen(status, band(`${fg(229, 229, 231)}▏${RESET}${DARK_DIM}continue${RESET}`)))).toBeNull();
    expect(parseOmpSuggestion(screen(status, band(`${fg(229, 229, 231)}▏continue${RESET}`)))).toBeNull();
    // a prediction's own `▏` is part of it
    expect(parseOmpSuggestion(screen(status, band(`${DARK_DIM}▏continue${RESET}`)))).toBe("▏continue");
    expect(parseOmpSuggestion(screen(status, band(`|${DARK_DIM}continue${RESET}`)))).toBeNull();
  });

  test("colors in their colon form", () => {
    expect(parseOmpSuggestion(screen(status, band(`\u001b[38:2::95:102:115mopen the PR${RESET}`)))).toBe("open the PR");
    expect(parseOmpSuggestion(screen(status, band(`\u001b[38:2:95:102:115mopen the PR${RESET}`)))).toBe("open the PR");
    expect(parseOmpSuggestion(screen(status, band(`\u001b[38:2::229:229:231mhello typed text${RESET}`)))).toBeNull();
    // a typo's undercurl over typed text leaves its color as it was
    expect(parseOmpSuggestion(screen(status, band(`${fg(229, 229, 231)}\u001b[4:3m\u001b[58:2::255:95:95mhelo\u001b[4:0m\u001b[59m${RESET}`)))).toBeNull();
  });

  test("only a composer that ends the screen", () => {
    // something drawn under the prompt row
    expect(parseOmpSuggestion(screen(status, band(`${DARK_DIM}open the PR${RESET}`), "  /review  Review the changes"))).toBeNull();
    // grey text in a row that is no prompt row
    expect(parseOmpSuggestion(screen(`${DARK_DIM}open the PR${RESET}`))).toBeNull();
    expect(parseOmpSuggestion(screen(status, `${DARK_DIM}open the PR${RESET}`))).toBeNull();
  });
});
