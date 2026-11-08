import { describe, expect, it } from "bun:test";
import type { UpdateStatus } from "../../shared/update.ts";
import { headerUpdate, readDesktopUpdate } from "./headerUpdate.ts";

const idle: UpdateStatus = {
  managed: true, auto_update: false, phase: "idle", current_revision: "a".repeat(40), latest_revision: "a".repeat(40),
  current_version: "0.5.1", latest_version: "0.5.1", available: false, checked_at: "2026-11-08T00:00:00.000Z", blocked_reason: null, error: null, step: null,
};
const available: UpdateStatus = { ...idle, latest_revision: "b".repeat(40), latest_version: "0.5.2", available: true };
const server = { status: available, busy: false, needsReload: false, failure: null, offered: "b".repeat(40) } as const;

describe("headerUpdate", () => {
  it("shows nothing while up to date", () => {
    expect(headerUpdate(null, { ...server, status: idle, offered: null }, null)).toBeNull();
    expect(headerUpdate(null, { ...server, status: null, offered: null }, null)).toBeNull();
  });

  it("offers the desktop app's release while it downloads, with its progress, and a restart once ready", () => {
    expect(headerUpdate({ phase: "downloading", version: "0.5.2", percent: 40 }, null, null)).toEqual({ kind: "get", version: "0.5.2", percent: 40, busy: true });
    expect(headerUpdate({ phase: "failed", version: "0.5.2" }, null, null)).toEqual({ kind: "get", version: "0.5.2", percent: null, busy: false });
    expect(headerUpdate({ phase: "ready", version: "0.5.2" }, null, null)).toEqual({ kind: "restart", version: "0.5.2" });
  });

  it("offers a server install's release, and follows the install it starts", () => {
    expect(headerUpdate(null, server, null)).toEqual({ kind: "get", version: "0.5.2", percent: null, busy: false });
    // an install starts with a check that reports nothing available: the button stays for the version asked for
    expect(headerUpdate(null, { ...server, busy: true, status: { ...available, phase: "checking", available: false } }, "0.5.2")).toEqual({ kind: "get", version: "0.5.2", percent: null, busy: true });
    const building = headerUpdate(null, { ...server, busy: true, status: { ...available, phase: "building", step: "build" } }, "0.5.2");
    expect(building).toMatchObject({ kind: "get", version: "0.5.2", busy: true });
    expect(building?.kind === "get" && building.percent).toBeGreaterThan(0);
  });

  it("offers nothing a server cannot install from here", () => {
    expect(headerUpdate(null, { ...server, status: { ...available, managed: false } }, null)).toBeNull();
    expect(headerUpdate(null, { ...server, failure: "restart" }, null)).toBeNull();
    expect(headerUpdate(null, { ...server, offered: null }, null)).toBeNull();
    // the reload after an install is the update notice's, which asks for unsent drafts first
    expect(headerUpdate(null, { ...server, needsReload: true, status: idle, offered: null }, null)).toBeNull();
  });
});

describe("readDesktopUpdate", () => {
  it("takes only a state the app could send", () => {
    expect(readDesktopUpdate({ phase: "downloading", version: "0.5.2", percent: 3 })).toEqual({ phase: "downloading", version: "0.5.2", percent: 3 });
    expect(readDesktopUpdate({ phase: "ready", version: "0.5.2" })).toEqual({ phase: "ready", version: "0.5.2" });
    expect(readDesktopUpdate({ phase: "downloading", version: "0.5.2" })).toBeNull();
    expect(readDesktopUpdate({ phase: "done", version: "0.5.2" })).toBeNull();
    expect(readDesktopUpdate(null)).toBeNull();
  });
});
