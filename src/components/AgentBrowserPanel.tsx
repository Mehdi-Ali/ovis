import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { AppWindow, Hand, Square, X } from "lucide-react";
import type { BrowserInput, BrowserStatus, BrowserTab, ServerMessage } from "../../shared/protocol.ts";
import { useT } from "../lib/i18n.ts";
import { useMachineSessions } from "../lib/machineSessionContext.tsx";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { useSheetHistory } from "../lib/sheetHistory.ts";
import "./FileViewer.css";
import "./AgentBrowserPanel.css";

export interface AgentBrowserPanelProps {
  machineId: string;
  paneId: string;
  blockedHosts: string[];
  onClose: () => void;
  docked?: boolean;
  panelStart?: ReactNode;
  covered?: boolean;
}

interface BrowserView {
  status: BrowserStatus | "unsupported" | "connecting";
  tabs: BrowserTab[];
  targetId: string | null;
  control: "you" | "other" | null;
  blocked: boolean;
}

interface Frame { data: string; width: number; height: number; targetId: string }

const CONNECTING: BrowserView = { status: "connecting", tabs: [], targetId: null, control: null, blocked: false };
const MOVE_EVERY_MS = 33;

/** CDP's modifier bits: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
function modifierBits(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

const BUTTON_NAMES = ["left", "middle", "right"] as const;

/**
 * The browser an agent in the pane drives, in the web page's panel slot: read-only by default, as the server
 * streams it (server/core/agent-browser.ts), with a floating Take control / Stop tile over the page. While this
 * tab holds control its clicks, wheel and keys go to the page; nothing typed is kept here, in a draft or a retry.
 */
export function AgentBrowserPanel({ machineId, paneId, blockedHosts, onClose, docked = true, panelStart, covered = false }: AgentBrowserPanelProps) {
  const t = useT();
  const socket = useMachineSessions()?.peek(machineId)?.socket ?? null;
  const [view, setView] = useState<BrowserView>(CONNECTING);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const surface = useFocusTrap<HTMLElement>(!docked, { paused: covered });
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const lastMove = useRef(0);
  const blockedKey = blockedHosts.join(",");
  useSheetSwipe(surface, docked || covered || view.control === "you" ? null : onClose);
  // a phone's sheet holds a history entry: Back closes it, as it does the web page's popup
  useSheetHistory(!docked, onClose);

  useEffect(() => {
    if (socket === null) return;
    setView(CONNECTING);
    setFrame(null);
    const blocked = blockedKey === "" ? [] : blockedKey.split(",");
    // kept by the socket, which sends it once the server says it streams browsers and again after each reconnect
    socket.watchBrowser(paneId, { blocked });
    const unsupported = (): void => { if (socket.featuresListed() && !socket.canWatchBrowser()) setView({ ...CONNECTING, status: "unsupported" }); };
    const off = socket.on((message: ServerMessage) => {
      if (message.type === "features" || message.type === "snapshot") { unsupported(); return; }
      if (message.type === "browser-state" && message.pane_id === paneId) {
        setView({ status: message.status, tabs: message.tabs, targetId: message.target_id, control: message.control, blocked: message.blocked });
        // another tab's last picture is never left up to be clicked
        if (message.status !== "live" || message.blocked) setFrame(null);
        else setFrame((shown) => (shown !== null && shown.targetId === message.target_id ? shown : null));
      } else if (message.type === "browser-frame" && message.pane_id === paneId) {
        setFrame({ data: message.data, width: message.width, height: message.height, targetId: message.target_id });
      } else if (message.type === "error" && message.pane_id === paneId && message.code.startsWith("browser_")) {
        setRefusal(message.code);
      }
    });
    unsupported();
    return () => { off(); socket.watchBrowser(paneId, null); };
  }, [socket, paneId, blockedKey]);

  useEffect(() => {
    if (docked || covered) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.isComposing || view.control === "you" || nativeModalOver(surface.current)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [docked, covered, onClose, surface, view.control]);

  const controlling = view.control === "you" && frame !== null;
  const frameRef = useRef(frame);
  frameRef.current = frame;

  // once, as control is taken: a later frame never pulls the keyboard back from elsewhere
  useEffect(() => {
    if (controlling && !covered) stage.current?.focus({ preventScroll: true });
  }, [controlling, covered]);

  useEffect(() => {
    const node = stage.current;
    if (!controlling || node === null || socket === null) return;
    // the wheel scrolls the page, not this panel: only a non-passive listener may keep it from the panel
    const onWheel = (event: WheelEvent): void => {
      const point = pagePoint(event.clientX, event.clientY);
      if (point === null) return;
      event.preventDefault();
      socket.browserInput(paneId, { kind: "wheel", ...point, dx: event.deltaX, dy: event.deltaY, modifiers: modifierBits(event) });
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [controlling, socket, paneId]);

  /** A point on the frame in the page's CSS pixels: null outside it, or kept to its edge (`clamp`, a captured drag). */
  function pagePoint(clientX: number, clientY: number, clamp = false): { x: number; y: number } | null {
    const box = image.current?.getBoundingClientRect();
    const shown = frameRef.current;
    if (!box || shown === null || box.width === 0 || box.height === 0) return null;
    let x = ((clientX - box.left) / box.width) * shown.width;
    let y = ((clientY - box.top) / box.height) * shown.height;
    if (clamp) { x = Math.min(Math.max(x, 0), shown.width); y = Math.min(Math.max(y, 0), shown.height); }
    return x < 0 || y < 0 || x > shown.width || y > shown.height ? null : { x: Math.round(x), y: Math.round(y) };
  }

  const send = (input: BrowserInput): void => { if (controlling) socket?.browserInput(paneId, input); };

  const onPointer = (action: "move" | "down" | "up") => (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!controlling) return;
    if (action === "move") {
      const now = performance.now();
      if (now - lastMove.current < MOVE_EVERY_MS) return;
      lastMove.current = now;
    }
    // a press held past the frame's edge still moves and lets go on the page, where the drag left it
    const captured = action !== "down" && event.currentTarget.hasPointerCapture(event.pointerId);
    const point = pagePoint(event.clientX, event.clientY, captured);
    if (point === null) return;
    if (action === "down") event.currentTarget.setPointerCapture(event.pointerId);
    const button = action === "move" ? (event.buttons & 1 ? "left" : "none") : BUTTON_NAMES[event.button] ?? "left";
    send({ kind: "mouse", action, ...point, button, ...(action === "move" ? {} : { clicks: 1 }), modifiers: modifierBits(event) });
  };

  const onKey = (action: "down" | "up") => (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!controlling || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // the local paste carries the text (onPaste below): the shortcut itself is not the page's
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    event.preventDefault();
    event.stopPropagation();
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
    send({ kind: "key", action, key: event.key, code: event.code, ...(printable && action === "down" ? { text: event.key } : {}), key_code: event.keyCode, modifiers: modifierBits(event) });
  };

  const take = (want: boolean): void => {
    setRefusal(null);
    socket?.controlBrowser(paneId, want);
  };

  const shown = view.tabs.find((tab) => tab.id === view.targetId) ?? null;
  const message = view.status === "unsupported" ? t("This PC's Ovis can't show an agent's browser yet. Update it to use this panel.")
    : view.status === "connecting" ? t("Looking for the pane's browser…")
    : view.status === "pipe-only" ? t("The agent drives its browser over a pipe, which Ovis can't watch. Start the browser with a DevTools port (--remote-debugging-port=0) to show it here.")
    : view.status === "none" ? t("No browser found in this pane. Ovis shows a Chromium browser an agent starts here with a DevTools port, such as agent-browser's.")
    : view.blocked ? t("This page's host is blocked on this device.")
    : frame === null ? t("Waiting for the page…")
    : null;
  const refusalText = refusal === "browser_control_refused" ? t("This device can only watch.") : refusal === null ? null : t("The browser did not take that. Try again.");

  const select = view.tabs.length > 1 ? (
    <select className="agent-browser-tabs" aria-label={t("Browser tab")} value={view.targetId ?? ""} onChange={(event) => socket?.watchBrowser(paneId, { targetId: event.target.value, blocked: blockedHosts })}>
      {view.tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.title || tab.url}</option>)}
    </select>
  ) : null;
  const close = <button type="button" className="icon-button file-viewer-action file-viewer-close" aria-label={t("Close agent browser")} title={t("Close agent browser")} onClick={onClose}><X aria-hidden="true" /></button>;

  return (
    <div className={docked ? "file-panel web-panel agent-browser" : "modal-scrim file-viewer-scrim"} onMouseDown={(event) => { if (!docked && event.target === event.currentTarget) onClose(); }}>
      {docked ? panelStart : null}
      <section ref={surface} className={docked ? "file-viewer file-viewer-docked" : "modal file-viewer web-panel-popup agent-browser"} role={docked ? undefined : "dialog"} aria-modal={docked ? undefined : true} aria-labelledby="agent-browser-title" tabIndex={-1}>
        <header className={docked ? "file-viewer-header file-viewer-header-docked" : "modal-header file-viewer-header file-viewer-header-stacked"}>
          {docked && <AppWindow aria-hidden="true" className="file-viewer-glyph" />}
          <div className={`${docked ? "file-viewer-name" : "file-viewer-title"} agent-browser-heading`}>
            <h2 className={docked ? undefined : "modal-title"} id="agent-browser-title"><span className="file-viewer-stem">{t("Agent browser")}</span></h2>
            {shown !== null && <span className="agent-browser-url" title={shown.url}>{shown.url}</span>}
          </div>
          {select}
          {close}
        </header>
        <div className="file-viewer-body web-panel-body agent-browser-body">
          <div ref={stage} className={`agent-browser-stage${controlling ? " is-controlling" : ""}`} tabIndex={controlling ? 0 : -1}
            aria-label={controlling ? t("Agent browser page: your clicks and keys go to it") : t("Agent browser page, view only")}
            onPointerDown={onPointer("down")} onPointerMove={onPointer("move")} onPointerUp={onPointer("up")} onPointerCancel={onPointer("up")} onKeyDown={onKey("down")} onKeyUp={onKey("up")}
            onCompositionEnd={(event) => { if (event.data) send({ kind: "text", text: event.data }); }}
            onPaste={(event) => { const text = event.clipboardData.getData("text"); if (controlling && text) { event.preventDefault(); send({ kind: "text", text }); } }}
            onContextMenu={(event) => { if (controlling) event.preventDefault(); }}>
            {frame !== null && message === null
              ? <img ref={image} className="agent-browser-frame" src={`data:image/jpeg;base64,${frame.data}`} alt={shown?.title || t("The agent's browser page")} draggable={false} />
              : <p className="agent-browser-note" role="status">{message}</p>}
          </div>
          {view.status === "live" && !view.blocked && frame !== null && (
            <div className="agent-browser-tile" role="group" aria-label={t("Browser control")}>
              {view.control === "you"
                ? <>
                  <span className="agent-browser-tile-note">{t("You have control. The agent may still act.")}</span>
                  <button type="button" className="btn agent-browser-tile-action" onClick={() => take(false)}><Square aria-hidden="true" />{t("Stop")}</button>
                </>
                : <>
                  {view.control === "other" && <span className="agent-browser-tile-note">{t("Another device has control.")}</span>}
                  <button type="button" className="btn agent-browser-tile-action" title={t("Send your clicks and keys to this page until you stop")} onClick={() => take(true)}><Hand aria-hidden="true" />{t("Take control")}</button>
                </>}
              {refusalText !== null && <span className="agent-browser-tile-note is-refused" role="alert">{refusalText}</span>}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
