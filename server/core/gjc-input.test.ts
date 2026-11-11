import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as herdr from "../herdr/client.ts";
import { freeGjcInput, InputDraftError } from "./composer.ts";

// gjc 0.18.12's last rows as herdr reads them from an owned pane (detection text, visible ansi)
const rows = JSON.parse(readFileSync(new URL("../fixtures/gjc-input-0.18.12-rows.json", import.meta.url), "utf8")) as Record<"empty", { text: string; ansi: string }>;
const strip = (ansi: string) => ansi.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").split("\n").map((row) => row.replace(/\r$/, "").trimEnd()).join("\n");
// gjc's suggested next prompt in the empty box, in its dim color, and the same words once taken in (Tab): typed
const ghost = rows.empty.ansi.replace(/Type your message[^\u001b]*/, `run the tests again${" ".repeat(93)}`);
const taken = ghost.replace("\u001b[38;2;111;71;67mrun the tests again", "\u001b[0mrun the tests again");

/** herdr's reads of the pane in the order freeGjcInput makes them, each kind answered from its own list */
function reads(text: string[], ansi: string[], at: { offset_from_bottom: number; viewport_rows: number } | null = null, sources: string[] = []) {
  const read = spyOn(herdr, "paneRead").mockImplementation(async (options) => {
    sources.push(options.source ?? "");
    const answer = options.format === "ansi" ? ansi.shift() : text.shift();
    if (answer === undefined) throw new Error(`an unexpected ${options.format} read`);
    return { text: answer } as Awaited<ReturnType<typeof herdr.paneRead>>;
  });
  const scroll = spyOn(herdr, "paneScrollInfo").mockResolvedValue(at as Awaited<ReturnType<typeof herdr.paneScrollInfo>>);
  return () => { read.mockRestore(); scroll.mockRestore(); };
}

describe("freeGjcInput (#3627)", () => {
  let restore = () => {};
  afterEach(() => restore());

  it("lets a send go over gjc's own suggestion, drawn alike in both colored reads", async () => {
    restore = reads([strip(ghost), strip(ghost)], [ghost, ghost]);
    expect(await freeGjcInput("w1:p1")).toBe(strip(ghost));
  });

  it("refuses when the suggestion was taken into the box between the colored reads: the same words, now typed", async () => {
    restore = reads([strip(ghost), strip(taken)], [ghost, taken]);
    await expect(freeGjcInput("w1:p1")).rejects.toBeInstanceOf(InputDraftError);
  });

  it("lets a send go when only gjc's footer or spinner was redrawn between the reads", async () => {
    const empty = rows.empty.ansi;
    const redrawn = empty.replace("⬢", "◒");
    expect(redrawn).not.toBe(empty);
    restore = reads([strip(empty), strip(redrawn)], [empty, redrawn]);
    expect(await freeGjcInput("w1:p1")).toBe(strip(redrawn));
  });

  it("reads the history's last rows for the colors while the viewport is scrolled up, and lets a send go over the placeholder", async () => {
    const sources: string[] = [];
    restore = reads([strip(rows.empty.ansi), strip(rows.empty.ansi)], [rows.empty.ansi, rows.empty.ansi], { offset_from_bottom: 1, viewport_rows: 40 }, sources);
    expect(await freeGjcInput("w1:p1")).toBe(strip(rows.empty.ansi));
    expect(sources).toEqual(["detection", "recent", "detection", "recent"]);
  });
});
