/**
 * DEMO ONLY (lane settings-help; goes before the pull request): which way a Settings row's sentence
 * shows, so the ways can be compared on one build. `?help=` on the address the app is opened at
 * picks one; it is read here as the app starts, since the app then writes its own address over it,
 * and kept for the tab.
 *
 * - `line` (the default): the sentence shows over the page on a resting mouse and on keyboard focus, a finger
 *   taps the row's name, and the few rows whose name alone misleads keep one short line in sight.
 * - `hover`: the same without those extra lines.
 * - `info`: as `hover`, and every row with a sentence carries a quiet button that opens it in the row.
 * - `off`: Settings as on main today.
 */
export type HelpDemo = "hover" | "info" | "line" | "off";

const KEY = "ovis:help-demo";

try {
  const asked = new URLSearchParams(window.location.search).get("help");
  if (asked !== null) sessionStorage.setItem(KEY, asked);
} catch {
  // no window or no storage (a test, a locked-down browser): the default stands
}

export function helpDemo(): HelpDemo {
  try {
    const value = sessionStorage.getItem(KEY);
    return value === "hover" || value === "info" || value === "off" ? value : "line";
  } catch {
    return "line";
  }
}
