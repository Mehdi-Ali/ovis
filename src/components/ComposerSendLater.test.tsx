import { afterEach, beforeEach, expect, it, mock, spyOn } from "bun:test";
import * as reactDom from "react-dom";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { Composer, type ComposerProps } from "./Composer.tsx";
import * as settingsModule from "../lib/settings.ts";
import * as commandsModule from "../lib/usePaneCommands.ts";
import * as usageModule from "../lib/usage.ts";
import * as voiceModule from "./VoiceInput.tsx";
import * as facesModule from "../lib/fontFaces.ts";
import * as trapModule from "../lib/useFocusTrap.ts";
import { composerDrafts } from "../lib/composerDraft.ts";
import { paneLifetimes } from "../lib/paneLifetime.ts";

// #2919: Send later hands the box's text and a time to the PC, which keeps it; the button is opt-in
const pane = "later-pane", draftKey = `ovis:composer-draft:${pane}`;
const globals = ["window", "document", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"];
const saved = new Map<string, PropertyDescriptor | undefined>();
let renderer: ReactTestRenderer | undefined;
let sendLater = true;

beforeEach(() => {
  sendLater = true;
  for (const key of globals) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const listen = { addEventListener() {}, removeEventListener() {} };
  const values: Record<string, unknown> = {
    IS_REACT_ACT_ENVIRONMENT: true,
    navigator: { languages: ["en"], userAgent: "test", maxTouchPoints: 0 },
    window: { ...listen, location: { href: "https://ovis.test/" }, matchMedia: () => ({ matches: false, ...listen }), setTimeout, clearTimeout, history: { state: null, pushState() {}, back() {} } },
    document: { ...listen, querySelector: () => null, body: {} },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  };
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[key] });
  const data = new Map<string, string>();
  spyOn(paneLifetimes.paneStorage, "getItem").mockImplementation((key) => data.get(key) ?? null);
  spyOn(paneLifetimes.paneStorage, "setItem").mockImplementation((key, value) => { data.set(key, value); });
  spyOn(paneLifetimes.paneStorage, "removeItem").mockImplementation((key) => { data.delete(key); });
  spyOn(settingsModule, "useSettings").mockImplementation(() => ({ settings: { ...settingsModule.DEFAULT_SETTINGS, showUsage: false, composerSendLater: sendLater }, resolvedLanguage: "en" }) as ReturnType<typeof settingsModule.useSettings>);
  spyOn(commandsModule, "usePaneCommands").mockReturnValue([]);
  spyOn(usageModule, "useUsage").mockReturnValue({ report: null } as ReturnType<typeof usageModule.useUsage>);
  spyOn(facesModule, "useFacesArrived").mockReturnValue(0);
  spyOn(voiceModule, "useDictation").mockReturnValue({ shown: false, voice: { state: "idle" }, forget() {} } as unknown as ReturnType<typeof voiceModule.useDictation>);
  // the dialog draws in place: the test renderer has no document to portal into
  spyOn(reactDom, "createPortal").mockImplementation(((node: unknown) => node) as typeof reactDom.createPortal);
  spyOn(trapModule, "useFocusTrap").mockImplementation(() => ({ current: null }));
  composerDrafts.set(draftKey, "");
});

afterEach(() => {
  act(() => { renderer?.unmount(); });
  renderer = undefined;
  composerDrafts.set(draftKey, "");
  mock.restore();
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  saved.clear();
});

function props(scheduled: Array<[string, string]> | null): ComposerProps {
  return {
    paneId: pane, agent: "claude", agentStatus: "idle", connected: true, autoFocus: false, onSend: () => true, onAbort() {}, onUploadImage: async () => "",
    ...(scheduled ? { onSchedule: async (text: string, sendAt: string) => { scheduled.push([text, sendAt]); } } : {}),
  };
}

const button = () => renderer!.root.findAllByProps({ "aria-label": "Send later…" }).find((node) => node.type === "button");

it("draws no Send later button until this device turns it on", async () => {
  sendLater = false;
  composerDrafts.set(draftKey, "continue");
  await act(async () => { renderer = create(<Composer {...props([])} />); });
  expect(button()).toBeUndefined();
});

it("draws none where the PC cannot keep a scheduled message", async () => {
  composerDrafts.set(draftKey, "continue");
  await act(async () => { renderer = create(<Composer {...props(null)} />); });
  expect(button()).toBeUndefined();
});

it("schedules the box's text for the time picked, and empties the box once the PC keeps it", async () => {
  const scheduled: Array<[string, string]> = [];
  await act(async () => { renderer = create(<Composer {...props(scheduled)} />); });
  expect(button()!.props.disabled).toBe(true);
  await act(async () => { composerDrafts.set(draftKey, "continue"); });
  expect(button()!.props.disabled).toBe(false);
  await act(async () => { button()!.props.onClick(); });
  const tomorrow = renderer!.root.findAll((node) => node.type === "button" && node.props.children === "Tomorrow at 9:00")[0]!;
  await act(async () => { tomorrow.props.onClick(); });
  const form = renderer!.root.findByType("form");
  await act(async () => { form.props.onSubmit({ preventDefault() {} }); });
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0]![0]).toBe("continue");
  const at = new Date(scheduled[0]![1]);
  expect([at.getHours(), at.getMinutes()]).toEqual([9, 0]);
  expect(at.getTime()).toBeGreaterThan(Date.now());
  expect(composerDrafts.read(draftKey).text).toBe("");
  expect(renderer!.root.findAllByType("form")).toHaveLength(0);
});
