import { afterEach, beforeEach, expect, it, mock, setSystemTime, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { CACHE_TICK_MS, CacheChip } from "./CacheChip.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as sheetModule from "../lib/sheetHistory.ts";
import type { CacheSummary, CacheThread } from "../../shared/claude-cache.ts";

const globals = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
/** the window's listeners, so a test can press and key outside the chip */
const listeners = new Map<string, Set<(event: unknown) => void>>();

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const MIN = 60_000;

beforeEach(() => {
  setSystemTime(new Date(NOW));
  listeners.clear();
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    window: {
      addEventListener: (type: string, handler: (event: unknown) => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(handler); },
      removeEventListener: (type: string, handler: (event: unknown) => void) => { listeners.get(type)?.delete(handler); },
    },
    document: { activeElement: null },
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: settingsModule.DEFAULT_SETTINGS, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(sheetModule, "usePhoneSheetBack").mockImplementation(() => {});
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  mock.restore();
  setSystemTime();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

const thread = (patch: Partial<CacheThread> = {}): CacheThread => ({
  requests: 12, input: 40, cache_read: 3_900_000, cache_write: 120_000, last_at: NOW - 18 * MIN, ttl_ms: 60 * MIN, last_prompt: 340_000,
  recent: [
    { prompt: 300_000, read: 290_000, write: 1_000, miss: false },
    { prompt: 300_000, read: 290_000, write: 1_000, miss: false },
    { prompt: 340_000, read: 2_000, write: 48_000, miss: true },
  ], last_id: "m12", ...patch,
});
const summary = (main: Partial<CacheThread> = {}, subagents: CacheSummary["subagents"] = []): CacheSummary => ({ main: thread(main), subagents });

const render = (cache: CacheSummary | undefined, compact = false) => {
  act(() => { renderer = create(<CacheChip cache={cache} compact={compact} />); });
  return renderer!;
};
const chip = () => renderer!.root.findByType("button");
const word = () => chip().findAll((node) => node.type === "span").map((node) => node.children.join("")).join("");
const popover = () => renderer!.root.findAll((node) => node.props.role === "dialog");
const press = () => act(() => { chip().props.onClick(); });

it("draws nothing until an answer reported usage", () => {
  expect(render(undefined).toJSON()).toBeNull();
  act(() => { renderer?.unmount(); });
  expect(render({ main: thread({ requests: 0, last_at: null }) }).toJSON()).toBeNull();
});

it("shows the estimated minutes left, green over 15, on the main thread's own clock", () => {
  render(summary());
  expect(word()).toBe("42m");
  expect(chip().props.className).toContain("is-green");
  expect(chip().props.title).toBe("Estimated: Anthropic does not report cache expiry");
  expect(chip().props["aria-label"]).toBe("Prompt cache, about 42m left");
});

it("turns yellow at 15 minutes and under, and grey with ≈cold at 0", () => {
  render(summary({ last_at: NOW - 50 * MIN }));
  expect(word()).toBe("10m");
  expect(chip().props.className).toContain("is-yellow");
  act(() => { renderer?.unmount(); });
  render(summary({ last_at: NOW - 61 * MIN }));
  expect(word()).toBe("≈cold");
  expect(chip().props.className).toContain("is-cold");
});

it("counts down on its own 30 s tick from the last request, with no new data", () => {
  const ticks: { fn: () => void; ms: number }[] = [];
  spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => { ticks.push({ fn, ms }); return 1; }) as unknown as typeof setInterval);
  spyOn(globalThis, "clearInterval").mockImplementation((() => {}) as unknown as typeof clearInterval);
  render(summary({ last_at: NOW - 40 * MIN }));
  expect(word()).toBe("20m");
  expect(ticks.map((tick) => tick.ms)).toEqual([CACHE_TICK_MS]);
  // ten minutes on, the same data reads ten minutes less
  setSystemTime(new Date(NOW + 10 * MIN));
  act(() => { ticks[0]!.fn(); });
  expect(word()).toBe("10m");
  expect(chip().props.className).toContain("is-yellow");
  setSystemTime(new Date(NOW + 25 * MIN));
  act(() => { ticks[0]!.fn(); });
  expect(word()).toBe("≈cold");
});

it("opens a popover of the main session, subagents, totals, the last requests and the cold line", () => {
  render(summary({ last_at: NOW - 61 * MIN }, [
    { id: "a1", title: "qa-reviewer", thread: thread({ last_at: NOW - 30 * MIN, ttl_ms: 5 * MIN, cache_read: 880, input: 20, cache_write: 100 }) },
    { id: "a2", title: "fetcher", thread: thread({ last_at: NOW - 2 * MIN, ttl_ms: 5 * MIN, cache_read: 91, input: 1, cache_write: 8 }) },
  ]));
  expect(popover().length).toBe(0);
  press();
  expect(chip().props["aria-expanded"]).toBe(true);
  const text = JSON.stringify(renderer!.toJSON());
  expect(text).toContain("Cache (est.)");
  expect(text).toContain("Main session");
  expect(text).toContain("qa-reviewer");
  expect(text).toContain("fetcher");
  // the subagent that went cold reads ≈cold, the one with three minutes left reads 3m
  expect(text).toContain("≈cold");
  expect(text).toContain("3m");
  expect(text).toContain("Read 3.9M · Write 120k");
  expect(text).toContain("✗ miss (wrote 48k)");
  expect(text).toContain("Cold now: next send rewrites ~340k");
});

it("says nothing of a cold cache while the main one is warm", () => {
  render(summary());
  press();
  expect(JSON.stringify(renderer!.toJSON())).not.toContain("Cold now");
});

it("closes on Escape and on a press outside it, and not on a press inside", () => {
  render(summary());
  press();
  expect(popover().length).toBe(1);
  act(() => { for (const handler of listeners.get("pointerdown") ?? []) handler({ target: {} }); });
  expect(popover().length).toBe(0);
  press();
  act(() => { for (const handler of listeners.get("keydown") ?? []) handler({ key: "Enter" }); });
  expect(popover().length).toBe(1);
  act(() => { for (const handler of listeners.get("keydown") ?? []) handler({ key: "Escape" }); });
  expect(popover().length).toBe(0);
});

it("pairs the clock with its figure tightly on a narrow screen", () => {
  render(summary(), true);
  expect(chip().props.className).toContain("is-compact");
  expect(word()).toBe("42m");
});
