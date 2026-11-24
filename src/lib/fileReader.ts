import { pageAddress, pageSearch } from "./pageQuery.ts";
import { shellMode, type ShellMode } from "./shellMode.ts";

/** `pane`: the pane the file was opened from (Open in a new window), so the reader can edit inside its folder */
export interface ReaderTarget { machine: string; path: string; pane?: string | null }

const PARAM = "read";

export function readerHref(machine: string, path: string, pathname = window.location.pathname, mode: ShellMode = shellMode(), pane: string | null = null): string {
  const query = new URLSearchParams({ [PARAM]: path, machine });
  if (pane) query.set("pane", pane);
  return pageAddress(pathname, `?${query.toString()}`, "", mode);
}

export function readerFromSearch(search: string): ReaderTarget | null {
  const query = new URLSearchParams(search);
  const path = query.get(PARAM);
  if (path === null || path.trim() === "") return null;
  const pane = query.get("pane");
  return pane ? { machine: query.get("machine") || "local", path, pane } : { machine: query.get("machine") || "local", path };
}

/**
 * A PC's own server loads a new page for
 * every address it is sent to; in the hosted shell an address that changes only the fragment
 * (pasted, or Back and Forward) loads nothing, so one that turns the page into the other, or puts
 * the reader on another PC, loads it.
 */
export function reloadWhenReaderChanges(loaded: ReaderTarget | null, page: { addEventListener(type: "hashchange", listener: () => void): void; location: { search: string; hash: string; reload(): void } } = window, mode: ShellMode = shellMode()): void {
  if (mode !== "relay") return;
  page.addEventListener("hashchange", () => {
    const next = readerFromSearch(pageSearch(page.location, mode));
    if ((next === null) !== (loaded === null) || (next !== null && next.machine !== loaded?.machine)) page.location.reload();
  });
}

/**
 * Above a `~/` document's home the `..` is kept (`~/../x.md`): only the PC knows where
 * its home is, and it expands the path.
 */
export function resolveFromDocument(document: string, target: string): string {
  if (/^(?:[\\/]|~\/|[A-Za-z]:[\\/])/.test(target)) return target;
  const folder = document.replace(/\\/g, "/").split("/").slice(0, -1);
  const home = folder[0] === "~";
  // a Windows share (//server/share) is a root as a whole: `..` never climbs above it
  const root = folder[0] === "" && folder[1] === "" && folder.length >= 4 ? 4 : 1;
  for (const part of target.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (folder.length > root && folder[folder.length - 1] !== "..") folder.pop();
      else if (home) folder.push("..");
    } else folder.push(part);
  }
  return folder.join("/") || "/";
}
