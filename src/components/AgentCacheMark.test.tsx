import { afterEach, beforeEach, expect, it, mock, setSystemTime, spyOn } from "bun:test";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AGENT_CACHE_TICK_MS, AgentCacheMark } from "./AgentCacheMark.tsx";
import * as settingsModule from "../lib/settings.ts";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const MIN = 60_000;
const saved = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  setSystemTime(new Date(NOW));
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: settingsModule.DEFAULT_SETTINGS, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  mock.restore();
  setSystemTime();
  if (saved) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", saved);
  else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const render = (last: number | null, ttl = 60 * MIN) => {
  act(() => { renderer = create(<AgentCacheMark cache={last === null ? undefined : { last_at: last, ttl_ms: ttl }} />); });
  return renderer!;
};
const mark = () => renderer!.root.findByProps({ "data-testid": "agent-cache" });
const text = () => mark().children.filter((child): child is string => typeof child === "string").join("");

it("draws nothing before a request reported usage", () => {
  expect(render(null).toJSON()).toBeNull();
});

it("says the minutes left in green over 15 minutes, with the clock and the estimate's tooltip", () => {
  render(NOW - 18 * MIN);
  expect(text()).toBe("42m");
  expect(mark().props.className).toBe("agent-cache is-green");
  expect(mark().props.title).toBe("Prompt cache (est.)");
  expect(mark().findAll((node) => node.type === "svg")).toHaveLength(1);
});

it("is yellow from 15 minutes down, and rounds seconds up so a live cache is not cold", () => {
  render(NOW - 45 * MIN);
  expect(text()).toBe("15m");
  expect(mark().props.className).toBe("agent-cache is-yellow");
  act(() => { renderer!.unmount(); });
  render(NOW - 60 * MIN + 20_000);
  expect(text()).toBe("1m");
  expect(mark().props.className).toBe("agent-cache is-yellow");
});

it("says ≈cold in grey, with no clock, once the time is out", () => {
  render(NOW - 61 * MIN);
  expect(text()).toBe("≈cold");
  expect(mark().props.className).toBe("agent-cache is-cold");
  expect(mark().findAll((node) => node.type === "svg")).toHaveLength(0);
});

it("counts down on one shared 30 s tick for every row, and stops it with the last row", () => {
  const ticks: { fn: () => void; ms: number }[] = [];
  const stopped: unknown[] = [];
  spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => { ticks.push({ fn, ms }); return 7; }) as unknown as typeof setInterval);
  spyOn(globalThis, "clearInterval").mockImplementation(((id: unknown) => { stopped.push(id); }) as unknown as typeof clearInterval);
  act(() => { renderer = create(<><AgentCacheMark cache={{ last_at: NOW - 40 * MIN, ttl_ms: 60 * MIN }} /><AgentCacheMark cache={{ last_at: NOW - 50 * MIN, ttl_ms: 60 * MIN }} /></>); });
  const words = () => renderer!.root.findAllByProps({ "data-testid": "agent-cache" }).map((node) => node.children.filter((child) => typeof child === "string").join(""));
  expect(words()).toEqual(["20m", "10m"]);
  expect(ticks.map((tick) => tick.ms)).toEqual([AGENT_CACHE_TICK_MS]);
  // ten minutes on, the same data reads ten minutes less
  setSystemTime(new Date(NOW + 10 * MIN));
  act(() => { ticks[0]!.fn(); });
  expect(words()).toEqual(["10m", "≈cold"]);
  act(() => { renderer!.unmount(); });
  renderer = undefined;
  expect(stopped).toEqual([7]);
});
