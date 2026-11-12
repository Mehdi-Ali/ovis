import { describe, expect, test } from "bun:test";
import { unsaidTokens } from "./paneName.ts";

describe("unsaidTokens", () => {
  test("drops a plugin line that only repeats the row's title, workspace and state", () => {
    expect(unsaidTokens(["claude d", "⠀⠀Coding · idle"], ["claude d", "Coding"])).toEqual([]);
  });
  test("keeps a token with anything new in it", () => {
    expect(unsaidTokens(["Coding · 42% quota", "claude d"], ["claude d", "Coding"])).toEqual(["Coding · 42% quota"]);
  });
  test("keeps tokens when the row says nothing they say", () => {
    expect(unsaidTokens(["5h 80%"], ["claude d"])).toEqual(["5h 80%"]);
  });
});
