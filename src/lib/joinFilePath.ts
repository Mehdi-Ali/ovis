/** `target` (a link as written in a markdown file) from the folder of `from`: `..` and `.` resolved, `/` between parts. */
export function joinFilePath(from: string, target: string): string {
  if (/^(?:[a-z]:)?[\\/]/i.test(target) || target.startsWith("~/")) return target;
  const parts = from.split(/[\\/]/).slice(0, -1);
  for (const part of target.split(/[\\/]/)) {
    if (part === "" || part === ".") continue;
    if (part === ".." && parts.length > 1) parts.pop();
    else if (part !== "..") parts.push(part);
  }
  return parts.join("/");
}
