import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sheetStep } from "./historyKeys.ts";
import { backUnderCurrentEntry } from "./historyNavigation.ts";

let originalWindow: PropertyDescriptor | undefined;
const answering = sheetStep.goingBack;

beforeEach(() => { originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window"); });
afterEach(() => {
  sheetStep.goingBack = answering;
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
});

/** A window with a history of `entries`, on its last one, with the Navigation API when `listed`. */
function browser(entries: string[], listed: boolean) {
  const went: Array<number | string> = [];
  const window = {
    history: { state: { entry: entries.at(-1) }, go: (by: number) => { went.push(by); } },
    ...(listed ? { navigation: {
      currentEntry: { index: entries.length - 1 },
      entries: () => entries.map((key) => ({ key })),
      traverseTo: (key: string) => { went.push(key); return { committed: Promise.resolve() }; },
    } } : {}),
  };
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: window });
  return went;
}

describe("an overlay's own step back", () => {
  it("is told to the sheets from the entry it leaves, and goes past a sheet's entry that lies over the overlay's", () => {
    const told: unknown[] = [];
    let over = false;
    sheetStep.goingBack = (state) => { told.push(state); return over; };
    const went = browser(["pane", "file"], false);
    backUnderCurrentEntry();
    over = true;
    backUnderCurrentEntry(2);
    expect(told).toEqual([{ entry: "file" }, { entry: "file" }]);
    expect(went).toEqual([-1, -3]);
  });

  it("goes by the browser's own list of entries where it has one", async () => {
    let over = false;
    sheetStep.goingBack = () => over;
    const went = browser(["start", "pane", "file", "menu"], true);
    await backUnderCurrentEntry();
    over = true;
    await backUnderCurrentEntry();
    expect(went).toEqual(["file", "pane"]);
  });
});
