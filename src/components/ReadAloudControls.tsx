// local patch: the chat's read-aloud buttons (src/lib/useReadAloud.ts). Read while idle; Pause or
// Resume and Stop while reading. pointerdown is cancelled so that pressing the button does not
// clear the text selection it is about to read (a phone tap would otherwise drop it first).
import { LoaderCircle, Pause, Play, Square, Volume2 } from "lucide-react";

import { useT } from "../lib/i18n.ts";
import type { ReadAloud } from "../lib/useReadAloud.ts";

export function ReadAloudControls({ read }: { read: ReadAloud }) {
  const t = useT();
  const hold = (event: { preventDefault: () => void }) => { event.preventDefault(); read.capture(); };
  if (read.state === "idle") {
    return <div className="read-aloud-controls">
      <button type="button" className="btn read-aloud-btn is-icon" aria-label={t("Read aloud")} title={t("Read aloud (the selection, else the last reply)")}
        onPointerDown={hold} onMouseDown={(event) => event.preventDefault()} onClick={read.start}><Volume2 aria-hidden="true" /></button>
    </div>;
  }
  return <div className="read-aloud-controls">
    {read.state === "loading"
      ? <button type="button" className="btn read-aloud-btn is-icon" aria-label={t("Loading speech")} disabled><LoaderCircle className="read-aloud-spin" aria-hidden="true" /></button>
      : <button type="button" className="btn read-aloud-btn is-icon" aria-label={read.state === "paused" ? t("Resume reading") : t("Pause reading")} title={read.state === "paused" ? t("Resume reading") : t("Pause reading")}
        onPointerDown={(event) => event.preventDefault()} onClick={read.toggle}>{read.state === "paused" ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}</button>}
    <button type="button" className="btn read-aloud-btn is-icon" aria-label={t("Stop reading")} title={t("Stop reading")}
      onPointerDown={(event) => event.preventDefault()} onClick={read.stop}><Square aria-hidden="true" /></button>
  </div>;
}
