import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsProvider } from "../lib/settings.ts";
import { keyIdGroups } from "./KeyId.tsx";
import { RelayShell, type RelayShellProps } from "./RelayShell.tsx";

const EXPECTED = "0123456789abcdef0123456789abcdef";
/** the same id but for its third and last groups */
const RECEIVED = "01234567ffffcdef0123456789abeeee";
const none = () => {};
const props = (state: RelayShellProps["state"]): RelayShellProps => ({ state, scoped: true, iosTab: false, onPair: none, onRetry: none, onCancel: none, onBack: none, onForget: none, onUpdate: none, onMatch: none, onCodeStart: none, onCodeSubmit: none, onCodeMatch: none });
const render = (shown: RelayShellProps): string => {
  const saved = Object.getOwnPropertyDescriptor(navigator, "languages");
  Object.defineProperty(navigator, "languages", { configurable: true, value: ["en"] });
  try {
    return renderToStaticMarkup(createElement(SettingsProvider, { children: createElement(RelayShell, shown) }));
  } finally {
    if (saved) Object.defineProperty(navigator, "languages", saved);
    else Reflect.deleteProperty(navigator, "languages");
  }
};
const groupsOf = (html: string) => [...html.matchAll(/<span class="(key-id-group(?: key-id-differs)?)">([0-9a-f]{4})/g)].map(([, kind, group]) => [group, kind === "key-id-group key-id-differs"]);

describe("a key that is not the PC's", () => {
  it("splits an id into eight groups of four", () => {
    expect(keyIdGroups(EXPECTED)).toEqual(["0123", "4567", "89ab", "cdef", "0123", "4567", "89ab", "cdef"]);
  });

  for (const state of [
    { kind: "forged", name: "Desk", mismatch: { expected: EXPECTED, received: RECEIVED, from: "link" } },
    { kind: "failed", failure: "identity-changed", name: "Desk", detail: null, mismatch: { expected: EXPECTED, received: RECEIVED, from: "saved" } },
  ] as const) {
    it(`shows the PC's id and the other key's, marking the groups that differ (${state.kind})`, () => {
      const html = render(props(state));
      expect(html).toContain('data-relay-state="identity-changed"');
      const [pcGroups, receivedGroups] = [groupsOf(html).slice(0, 8), groupsOf(html).slice(8)];
      expect(pcGroups.every(([, differs]) => differs === false)).toBe(true);
      expect(receivedGroups).toEqual([["0123", false], ["4567", false], ["ffff", true], ["cdef", false], ["0123", false], ["4567", false], ["89ab", false], ["eeee", true]]);
      // a differing group is named for a screen reader, not told by colour alone
      expect(html.match(/visually-hidden">\s*differs</g)).toHaveLength(2);
    });
  }

  it("never calls an id the PC's: each is labelled by where it came from", () => {
    const forged = render(props({ kind: "forged", name: "Desk", mismatch: { expected: EXPECTED, received: RECEIVED, from: "link" } }));
    expect(forged).not.toContain("This PC&#x27;s ID");
    expect(forged).toContain("ID this link names");
    expect(forged).toContain("ID of the key this link carries");
    // a bad saved key under a genuine link is the saved key's, not the link's
    const changed = render(props({ kind: "failed", failure: "identity-changed", name: "Desk", detail: null, mismatch: { expected: EXPECTED, received: RECEIVED, from: "saved" } }));
    expect(changed).toContain("ID this phone paired with");
    expect(changed).toContain("ID of the key this phone saved");
    expect(changed).not.toContain("this link carries");
  });

  it("says a key that does not parse is not a valid key, and still shows the PC's id", () => {
    const html = render(props({ kind: "forged", name: null, mismatch: { expected: EXPECTED, received: null, from: "link" } }));
    expect(html).toContain("Not a valid key");
    expect(groupsOf(html)).toHaveLength(8);
  });
});

describe("pairing with a typed code", () => {
  it("shows every group of the ID a code found before anything is paired", () => {
    const html = render(props({ kind: "code-compare", offer: { v: 1, server_id: EXPECTED, server_public_key: "k", relay: "wss://relay.example", code: "123456", name: "Desk" } }));
    for (const group of keyIdGroups(EXPECTED)) expect(html).toContain(`>${group}<`);
    expect(html).toContain("It matches");
    expect(html).toContain('data-relay-state="code-compare"');
  });

  it("keeps the code in its field only, and says why the last one gave no PC", () => {
    const html = render(props({ kind: "code-entry", failure: "no-pc" }));
    expect(html).toMatch(/<input[^>]*name="code"/);
    expect(html).not.toMatch(/<input[^>]*name="code"[^>]*value=/);
    expect(html).toContain("No PC shows this code");
  });
});
