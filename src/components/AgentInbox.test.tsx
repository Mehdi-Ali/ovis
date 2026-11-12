import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, createRef } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import type { Machine } from "../../shared/machines.ts";
import type { AgentStatus, HerdrPane, InteractivePrompt } from "../../shared/protocol.ts";
import machinesFixture from "../../site/demo/fixtures/machines.json";
import { inboxKey, inboxOrder, type InboxFilter } from "../lib/agentInbox.ts";
import * as api from "../lib/api.ts";
import { PanePressContext } from "../lib/paneSubmitContext.ts";
import { SettingsProvider } from "../lib/settings.ts";
import type { SidebarActivity } from "../lib/sidebarActivity.tsx";

// the prompt read is the only request the list makes: each test answers it itself
let answerPrompt: (prompt: InteractivePrompt | null) => void = () => {};
let promptReads = 0;
let presses: string[] = [];
await mock.module("../lib/api.ts", () => ({
  ...api,
  fetchPanePromptState: () => {
    promptReads++;
    return new Promise<{ prompt: InteractivePrompt | null }>((resolve) => { answerPrompt = (prompt) => resolve({ prompt }); });
  },
}));
const { AgentInbox } = await import("./AgentInbox.tsx");

const fixture: Machine[] = JSON.parse(JSON.stringify(machinesFixture.machines));
const activity: SidebarActivity = {
  seqs: () => new Map(),
  status: (_machineId, pane) => pane.agent_status as AgentStatus | undefined,
};

function roster(edit: (pane: HerdrPane) => HerdrPane = (pane) => pane, state: Machine["state"] = "connected"): Machine[] {
  return structuredClone(fixture).map((machine) => ({
    ...machine, state,
    snapshot: machine.snapshot === null ? null : { ...machine.snapshot, panes: machine.snapshot.panes.map(edit) },
  }));
}

const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === "string" ? child : text(child)).join("");
const byClass = (root: ReactTestInstance, name: string): ReactTestInstance[] =>
  root.findAll((node) => typeof node.type === "string" && typeof node.props.className === "string" && node.props.className.split(" ").includes(name));

describe("AgentInbox", () => {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    promptReads = 0;
    presses = [];
    for (const key of ["window", "document", "navigator", "getComputedStyle", "IS_REACT_ACT_ENVIRONMENT"]) descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const events = new EventTarget();
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"] } });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      requestAnimationFrame: () => 1,
      cancelAnimationFrame() {},
      location: { href: "http://localhost/", search: "" },
    } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: () => ({ getPropertyValue: () => "" }) });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      body: { nodeType: 1, children: [] },
      documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } },
      querySelector: () => null,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    } });
  });

  afterEach(async () => {
    await act(async () => { renderer?.unmount(); });
    renderer = undefined;
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    descriptors.clear();
  });

  const draw = async (machines: Machine[], options: { filter?: InboxFilter; query?: string; watching?: boolean; onOpen?: (machineId: string, paneId: string) => void; onNew?: (machineId: string) => void } = {}) => {
    const scroll = createRef<number>() as { current: number };
    scroll.current = 0;
    await act(async () => {
      renderer = create(<SettingsProvider><PanePressContext.Provider value={(machineId, paneId) => presses.push(`${machineId}/${paneId}`)}><AgentInbox machines={machines} activity={activity} watching={options.watching ?? false} filter={options.filter ?? "all"} onFilter={() => {}}
        query={options.query ?? ""} onQuery={() => {}} scroll={scroll} onOpen={options.onOpen ?? (() => {})} onNew={options.onNew ?? (() => {})} /></PanePressContext.Provider></SettingsProvider>,
      { createNodeMock: () => ({ focus() {}, scrollTop: 0 }) });
    });
    return renderer!.root;
  };
  const item = (root: ReactTestInstance, paneId: string) => byClass(root, "inbox-item").find((node) => node.props["data-pane"] === paneId)!;

  it("draws one row per agent, in the inbox's order", async () => {
    const machines = roster();
    const root = await draw(machines);
    const keys = byClass(root, "inbox-item").map((node) => `${node.props["data-machine"]}:${node.props["data-pane"]}`);
    expect(keys).toEqual(inboxOrder(machines, activity).map(inboxKey));
    expect(keys.length).toBeGreaterThan(1);
  });

  it("marks a waiting row with the dot and the INPUT chip, and a resting one with no chip", async () => {
    const root = await draw(roster());
    const blocked = item(root, "w1D:p1");
    expect(byClass(blocked, "inbox-dot")).toHaveLength(1);
    const chip = blocked.findAll((node) => node.type === "span" && node.props.className === "badge badge-blocked inbox-chip");
    expect(chip.map(text)).toEqual(["INPUT"]);
    expect(byClass(item(root, "w1E:p1"), "badge")).toEqual([]);
  });

  it("draws only the working rows under the working filter, that filter chosen", async () => {
    const root = await draw(roster(), { filter: "working" });
    expect(byClass(root, "inbox-item").map((node) => node.props["data-state"])).toEqual(["working"]);
    const chosen = byClass(root, "inbox-filter").filter((node) => node.props["aria-checked"] === true);
    expect(chosen.map((node) => node.props["data-status"])).toEqual(["working"]);
  });

  it("opens a row's agent on its PC when pressed", async () => {
    const opened: string[] = [];
    const root = await draw(roster(), { onOpen: (machineId, paneId) => opened.push(`${machineId}/${paneId}`) });
    const row = byClass(item(root, "w1C:p1"), "inbox-row")[0]!;
    await act(async () => { row.props.onPointerDown({ button: 0 }); row.props.onClick(); });
    expect(presses).toEqual(["local/w1C:p1"]);
    expect(opened).toEqual(["local/w1C:p1"]);
  });

  it("says what a working agent is on from its plan", async () => {
    const plan = { current: "Write the export guard test", done: 1, total: 3 };
    const root = await draw(roster((pane) => pane.pane_id === "w1C:p1" ? { ...pane, plan } as HerdrPane : pane));
    expect(byClass(item(root, "w1C:p1"), "inbox-words").map(text)).toEqual(["Write the export guard test"]);
  });

  it("draws a PC that is away as disabled rows that say Offline and open nothing", async () => {
    const opened: string[] = [];
    const root = await draw(roster(undefined, "disconnected"), { onOpen: (machineId, paneId) => opened.push(`${machineId}/${paneId}`) });
    const items = byClass(root, "inbox-item");
    expect(items.length).toBeGreaterThan(0);
    for (const node of items) {
      const row = byClass(node, "inbox-row")[0]!;
      expect(row.props.disabled).toBe(true);
      expect(byClass(node, "inbox-place").map(text).join("")).toContain("Offline");
      await act(async () => { row.props.onPointerDown({ button: 0 }); });
    }
    expect(presses).toEqual([]);
    expect(opened).toEqual([]);
    expect(byClass(root, "inbox-new")).toEqual([]);
  });

  it("offers a watching device no New workspace", async () => {
    expect(byClass(await draw(roster(), { watching: true }), "inbox-new")).toEqual([]);
  });

  it("offers New workspace on the one connected PC", async () => {
    const asked: string[] = [];
    const root = await draw(roster(), { onNew: (machineId) => asked.push(machineId) });
    await act(async () => { byClass(root, "inbox-new")[0]!.props.onClick({ currentTarget: {} }); });
    expect(asked).toEqual(["local"]);
  });

  it("says no agent matches a query that keeps none, and draws no list", async () => {
    const root = await draw(roster(), { query: "nothing is called this" });
    expect(byClass(root, "inbox-empty").map(text)).toEqual(["No agents match"]);
    expect(byClass(root, "inbox-list")).toEqual([]);
  });

  it("says the agents are loading while no PC has come in", async () => {
    const root = await draw([]);
    expect(byClass(root, "inbox-empty").map(text)).toEqual(["Loading agents…"]);
  });

  it("shows the question a waiting agent asks when it reported no words of its own", async () => {
    const root = await draw(roster());
    expect(promptReads).toBe(1);
    expect(byClass(item(root, "w1D:p1"), "inbox-words")).toEqual([]);
    const prompt = {
      id: "p", agent: "codex", kind: "approval", title: "Approve", question: "Run the export tests?", body: "bun test ./src/export.test.ts",
      options: [], multi_select: false, custom_option_index: null,
    } as InteractivePrompt;
    await act(async () => { answerPrompt(prompt); });
    expect(byClass(item(root, "w1D:p1"), "inbox-words").map(text)).toEqual(["Run the export tests?\nbun test ./src/export.test.ts"]);
  });
});
