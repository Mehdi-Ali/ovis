import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from "bun:test";

/**
 * The module on a browser whose Back skips the entries of a page that added one with no tap since
 * the last Back or Forward (Chromium): it is told by `navigator.userActivation` and a Chrome user
 * agent, read once when the module loads, so this file has a browser of its own.
 */
let originalWindow: PropertyDescriptor | undefined;
let originalNavigator: PropertyDescriptor | undefined;

/** A history with the browser's key for each entry (kept by a replace, new with a push), the Navigation API's way onto one, and taps. */
function fakeBrowser() {
  let keys = 0;
  const entries: Array<{ state: unknown; href: string; key: string }> = [{ state: null, href: "/?pane=a", key: "k0" }];
  let index = 0;
  const listeners = new Map<string, Array<(event: { state: unknown }) => void>>();
  const activation = { isActive: false };
  const land = (next: number): void => {
    if (next === index || next < 0 || next >= entries.length) return;
    index = next;
    queueMicrotask(() => { const event = { state: entries[index]!.state }; for (const listener of listeners.get("popstate") ?? []) listener(event); });
  };
  const history = {
    get state() { return entries[index]!.state; },
    pushState(state: unknown, _title: string, url?: string | null) { entries.splice(index + 1); keys += 1; entries.push({ state, href: url ?? entries[index]!.href, key: `k${keys}` }); index += 1; },
    replaceState(state: unknown, _title: string, url?: string | null) { entries[index] = { state, href: url ?? entries[index]!.href, key: entries[index]!.key }; },
    back() { land(index - 1); },
    forward() { land(index + 1); },
    go(by: number) { land(index + by); },
  };
  const window = {
    history,
    get location() { return { href: entries[index]!.href }; },
    navigation: {
      get currentEntry() { return { key: entries[index]!.key }; },
      traverseTo(key: string) { land(entries.findIndex((entry) => entry.key === key)); return { committed: Promise.resolve(), finished: Promise.resolve() }; },
    },
    addEventListener(type: string, listener: (event: { state: unknown }) => void) { listeners.set(type, [...(listeners.get(type) ?? []), listener]); },
  };
  return {
    window, entries, activation,
    at: () => index,
    key: () => entries[index]!.key,
    /** a tap the browser counts as one */
    tap: () => { activation.isActive = true; for (const listener of listeners.get("pointerup") ?? []) listener({ state: null }); },
  };
}
const fake = fakeBrowser();
const h = fake.window.history;
const settled = async () => {
  jest.advanceTimersByTime(1);
  for (let i = 0; i < 6; i++) await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));
};
let sheetHistory: typeof import("./sheetHistory.ts");
const enter = (onBack: () => boolean | void): (() => void) => { const id = sheetHistory.enterSheet(onBack, null); return () => sheetHistory.leaveSheet(id); };

beforeAll(async () => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: fake.window });
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Mobile Safari/537.36", userActivation: fake.activation } });
  const modulePath = "./sheetHistory.ts?sheet-history-skips-test";
  sheetHistory = await import(modulePath);
});
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.useRealTimers(); });
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window");
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else Reflect.deleteProperty(globalThis, "navigator");
});

describe("a phone's sheet where Back skips an entry made with no tap", () => {
  it("waits for a tap to make the entry of a sheet that opened with none, and makes it then", async () => {
    const start = fake.at();
    let closed = 0;
    // the page has seen no tap yet: a request that shows by itself
    const leave = enter(() => { closed += 1; });
    expect(fake.entries.length).toBe(start + 1);
    fake.tap();
    expect(fake.entries.length).toBe(start + 2); expect(fake.at()).toBe(start + 1);
    h.back(); await settled();
    expect(closed).toBe(1); expect(fake.at()).toBe(start);
    leave(); await settled();
  });

  it("makes no entry for a sheet that opens after a Back with no new tap, until one comes", async () => {
    const start = fake.at();
    fake.tap();
    const leaveFirst = enter(() => {});
    h.back(); await settled();
    leaveFirst(); await settled();
    expect(fake.at()).toBe(start);
    const entries = fake.entries.length;
    const leaveSecond = enter(() => {});
    expect(fake.entries.length).toBe(entries); expect(fake.at()).toBe(start);
    fake.tap();
    expect(fake.at()).toBe(start + 1);
    leaveSecond(); await settled();
    expect(fake.at()).toBe(start);
  });

  it("goes again onto the entry of a sheet that refuses Back, and tells the app both steps were the sheet's own", async () => {
    const start = fake.at();
    let busy = true;
    let asked = 0;
    const own: boolean[] = [];
    fake.window.addEventListener("popstate", () => { own.push(sheetHistory.sheetSteppedOff()); });
    fake.tap();
    const leave = enter(() => { asked += 1; if (busy) return false; });
    const entry = fake.key();
    const entries = fake.entries.length;
    h.back(); await settled();
    // the same entry, by the browser's key: none was added, so the next Back still finds it
    expect(asked).toBe(1); expect(fake.key()).toBe(entry); expect(fake.entries.length).toBe(entries);
    expect(own).toEqual([true, true]);
    busy = false;
    h.back(); await settled();
    expect(asked).toBe(2); expect(fake.at()).toBe(start);
    expect(own).toEqual([true, true, false]);
    leave(); await settled();
  });

  it("goes again onto the entry the sheet on top took from the one under it, which Back leaves up", async () => {
    const start = fake.at();
    let drawerClosed = 0;
    let menuClosed = 0;
    fake.tap();
    const leaveDrawer = enter(() => { drawerClosed += 1; });
    const entry = fake.key();
    fake.tap();
    const leaveMenu = enter(() => { menuClosed += 1; });
    const entries = fake.entries.length;
    expect(fake.key()).toBe(entry);
    h.back(); await settled();
    expect(menuClosed).toBe(1); expect(drawerClosed).toBe(0);
    expect(fake.key()).toBe(entry); expect(fake.entries.length).toBe(entries);
    leaveMenu(); await settled();
    expect(fake.key()).toBe(entry);
    // with no tap between: the entry Back lands off is the drawer's own again
    h.back(); await settled();
    expect(drawerClosed).toBe(1); expect(fake.at()).toBe(start);
    leaveDrawer(); await settled();
    expect(fake.at()).toBe(start);
  });
});
