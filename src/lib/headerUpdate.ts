/**
 * The update Settings' header offers on its right: the desktop app's own (its preload's
 * `ovisUpdates`, app/electron/src/preload.ts) or a server install's (lib/updates.ts). Nothing
 * while up to date, or when this install cannot be updated from here.
 */
import { useEffect, useState } from "react";
import type { DesktopUpdate } from "../../shared/update.ts";
import { versionLabel } from "./runningVersion.ts";
import { describeUpdate } from "./updateProgress.ts";
import type { UpdatesModel } from "./updates.ts";

export type HeaderUpdate =
  /** a release to get: `busy` while it downloads or installs, `percent` when that is known */
  | { kind: "get"; version: string; percent: number | null; busy: boolean }
  /** the desktop app downloaded it: a restart installs it */
  | { kind: "restart"; version: string };

type ServerUpdate = Pick<UpdatesModel, "status" | "busy" | "needsReload" | "failure" | "offered">;

/** `started`: the version an install was asked for from the button, while that install runs. */
export function headerUpdate(desktop: DesktopUpdate | null, server: ServerUpdate | null, started: string | null): HeaderUpdate | null {
  if (desktop) {
    if (desktop.phase === "ready") return { kind: "restart", version: desktop.version };
    return desktop.phase === "downloading"
      ? { kind: "get", version: desktop.version, percent: desktop.percent, busy: true }
      : { kind: "get", version: desktop.version, percent: null, busy: false };
  }
  if (!server) return null;
  const { status, busy, needsReload, failure, offered } = server;
  // the update notice asks for the reload a server install ends with, after unsent drafts are saved
  if (needsReload) return null;
  const installing = status?.phase === "building" || status?.phase === "restarting";
  // the check an install starts with reports nothing available until it is done
  const version = status?.latest_version ?? versionLabel(null, status?.latest_revision);
  if (installing || (started !== null && busy)) return { kind: "get", version: started ?? version ?? "", percent: describeUpdate(status)?.percent ?? null, busy: true };
  if (!status?.managed || !status.available || offered === null || failure !== null || version === null) return null;
  return { kind: "get", version, percent: null, busy };
}

/** A state the desktop app's preload passed on, or null for anything else. */
export function readDesktopUpdate(value: unknown): DesktopUpdate | null {
  if (typeof value !== "object" || value === null) return null;
  const { phase, version, percent } = value as Record<string, unknown>;
  if (typeof version !== "string") return null;
  if (phase === "downloading") return typeof percent === "number" ? { phase, version, percent } : null;
  return phase === "ready" || phase === "failed" ? { phase, version } : null;
}

interface DesktopUpdateBridge {
  state(): Promise<unknown>;
  onState(listener: (state: unknown) => void): () => void;
  act(): void;
}

function desktopBridge(): DesktopUpdateBridge | null {
  const bridge = typeof window === "undefined" ? undefined : (window as Window & { ovisUpdates?: Partial<DesktopUpdateBridge> }).ovisUpdates;
  return bridge && typeof bridge.state === "function" && typeof bridge.onState === "function" && typeof bridge.act === "function" ? bridge as DesktopUpdateBridge : null;
}

/** The desktop app's update and its button's action; null in a browser. */
export function useDesktopUpdate(): { update: DesktopUpdate | null; act: () => void } | null {
  const [bridge] = useState(desktopBridge);
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    // subscribed first, then read: a change between the two is not lost
    const stop = bridge.onState((state) => { if (live) setUpdate(readDesktopUpdate(state)); });
    bridge.state().then((state) => { if (live) setUpdate(readDesktopUpdate(state)); }, () => {});
    return () => { live = false; stop(); };
  }, [bridge]);
  return bridge ? { update, act: () => bridge.act() } : null;
}
