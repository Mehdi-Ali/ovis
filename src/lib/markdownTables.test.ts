import { describe, expect, test } from "bun:test";

import { splitRow } from "./markdownTables.ts";

describe("splitRow", () => {
  test("cells between pipes, outer pipes optional, escaped pipes and pipes in code kept", () => {
    expect(splitRow("| a | b | c |")).toEqual(["a", "b", "c"]);
    expect(splitRow("a | b")).toEqual(["a", "b"]);
    expect(splitRow("| x \\| y | `a|b` |")).toEqual(["x | y", "`a|b`"]);
    expect(splitRow("| --- | :---: |")).toEqual(["---", ":---:"]);
  });
});
