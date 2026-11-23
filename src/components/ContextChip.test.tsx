import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ContextChip, contextGrowth } from "./ContextChip.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as sheetModule from "../lib/sheetHistory.ts";
import type { CacheSummary, CacheThread } from "../../shared/claude-cache.ts";

const globals = ["window", "document", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
const listeners = new Map<string, Set<(event: unknown) => void>>();

beforeEach(() => {
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
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

const thread = (patch: Partial<CacheThread> = {}): CacheThread => ({
  requests: 4, input: 40, cache_read: 900_000, cache_write: 60_000, last_at: 0, ttl_ms: 3_600_000, last_prompt: 310_000,
  recent: [
    { prompt: 280_000, read: 270_000, write: 9_000, miss: false },
    { prompt: 290_000, read: 280_000, write: 9_000, miss: false },
    { prompt: 310_000, read: 290_000, write: 19_000, miss: false },
  ], last_id: "m4", ...patch,
});

const render = (used: number, window: number | null, cache?: CacheSummary, compact = false) => {
  act(() => { renderer = create(<ContextChip context={{ used, window }} cache={cache} compact={compact} />); });
  return renderer!;
};
const chip = () => renderer!.root.findByType("button");
const all = () => JSON.stringify(renderer!.toJSON());

it("draws nothing without a window", () => {
  expect(render(1000, null).toJSON()).toBeNull();
});

it("labels the share used, coloured, and opens and closes on press", () => {
  render(310_000, 1_000_000);
  expect(chip().props.className).toContain("is-ctx-yellow");
  expect(all()).toContain("ctx 31%");
  expect(renderer!.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
  act(() => { chip().props.onClick(); });
  expect(chip().props["aria-expanded"]).toBe(true);
  act(() => { chip().props.onClick(); });
  expect(renderer!.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
});

it("lists tokens left, the relay mark, the last request and the trend", () => {
  render(310_000, 1_000_000, { main: thread(), subagents: [{ id: "a1", title: "executor", thread: thread({ last_prompt: 42_000 }) }] });
  act(() => { chip().props.onClick(); });
  const json = all();
  expect(json).toContain("690k left");
  expect(json).toContain("Past the relay mark 200k by 110k");
  expect(json).toContain("Last request: 290k cached · 19k written · 1k new");
  expect(json).toContain("+15k/request");
  expect(json).toContain("requests until full at this rate");
  expect(json).toContain("executor");
  expect(json).toContain("42k");
});

it("counts down to the relay mark below it, and hides it for small windows", () => {
  render(150_000, 1_000_000);
  act(() => { chip().props.onClick(); });
  expect(all()).toContain("Relay mark 200k: 50k to go");
  act(() => { renderer?.unmount(); });
  render(50_000, 200_000);
  act(() => { chip().props.onClick(); });
  expect(all()).not.toContain("Relay mark");
});

it("closes on Escape", () => {
  render(310_000, 1_000_000);
  act(() => { chip().props.onClick(); });
  act(() => { for (const handler of listeners.get("keydown") ?? []) handler({ key: "Escape" }); });
  expect(renderer!.root.findAll((node) => node.props.role === "dialog")).toHaveLength(0);
});

it("averages growth per request", () => {
  expect(contextGrowth([100])).toBeNull();
  expect(contextGrowth([100, 200, 400])).toBe(150);
});
