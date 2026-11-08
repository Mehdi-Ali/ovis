/**
 * Settings → Experimental → Agent browser at 1280 and 390, light and dark, on an owned herdr pane whose shell
 * starts a headless Chromium with a DevTools port, as an agent would: off by default More offers nothing; on, More
 * opens the pane's browser beside the pane (a phone: a sheet) and shows its page; a click before Take control
 * reaches nothing, one after it reaches the page, and Stop hands control back. A blocked host is the server's
 * (server/core/agent-browser.test.ts): a file page has none.
 * Screenshots go to UI_EVIDENCE_DIR when it is set.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { paneSendText, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { CdpPage, pageTargets } from "../server/agent-browser/cdp.ts";
import { parseActivePort } from "../server/agent-browser/discover.ts";
import { chromePath } from "./chrome-path.ts";

process.env["OVIS_TELEMETRY"] = "0";
process.env["DORI_TELEMETRY"] = "0";

const root = mkdtempSync(join(tmpdir(), "ovis-agent-browser-"));
const profile = join(root, "agent-profile");
mkdirSync(profile);
const evidence = process.env["UI_EVIDENCE_DIR"] || null;
let server: ReturnType<typeof createServer> | undefined;
let workspace: string | undefined;
let browser: Browser | undefined;
// the page the agent's browser shows: a click anywhere on it retitles it. A file, as a browser launched from a shell
// does not always load a loopback http page before the run's deadline
const PAGE = join(root, "shop.html");
writeFileSync(PAGE, `<title>ready</title><body style="margin:0;height:100vh;background:#e8f0ff;font:32px sans-serif" onclick="document.title = 'clicked ' + (window.n = (window.n || 0) + 1)">ready to click</body>`);

/** the agent's page title, read over the agent browser's own DevTools port as the agent itself would */
async function agentTitle(): Promise<string> {
  const endpoint = parseActivePort(readFileSync(join(profile, "DevToolsActivePort"), "utf8"));
  assert.ok(endpoint !== null, "the agent's browser wrote its DevTools port");
  const [tab] = await pageTargets(endpoint.port);
  assert.ok(tab !== undefined, "the agent's browser has a page");
  const page = await CdpPage.open(endpoint.port, tab.id, () => {});
  try {
    const answer = await page.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }) as { result?: { value?: unknown } };
    return String(answer.result?.value);
  } finally {
    page.close();
  }
}

async function titleBecomes(want: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (await agentTitle() !== want) {
    if (Date.now() > deadline) throw new Error(`the agent's page never became "${want}"`);
    await Bun.sleep(100);
  }
}

const shot = async (page: Page, name: string): Promise<void> => { if (evidence) await page.screenshot({ path: join(evidence, `${name}.png`) }); };

async function open(origin: string, pane: string, width: number, theme: "light" | "dark", settings: Record<string, unknown>) {
  const phone = width <= 480;
  const context = await browser!.newContext({ viewport: { width, height: phone ? 844 : 900 }, locale: "en-US", hasTouch: phone, isMobile: phone, colorScheme: theme });
  await context.addInitScript((value) => { if (window.top === window && localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", value); }, JSON.stringify({ language: "en", theme, ...settings }));
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".header-more-button").waitFor();
  return { page, errors, close: () => context.close() };
}

/** Settings → Experimental → Agent browser is the server's (a shared preference): the server refuses every browser frame while it is off */
async function setPanel(origin: string, on: boolean): Promise<void> {
  const response = await fetch(`${origin}/api/preferences`, { method: "PUT", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ settings: { agentBrowserPanel: on } }) });
  assert.equal(response.status, 200, `the shared setting is saved (${response.status})`);
}

async function moreItems(page: Page): Promise<string[]> {
  await page.locator(".header-more-button").click();
  // a wide window draws More as a menu, a phone as a sheet of buttons
  await page.locator(".row-menu, .row-sheet").first().waitFor();
  const items = await page.locator(".row-menu [role^=menuitem], .row-sheet button").allTextContents();
  await page.keyboard.press("Escape");
  return items.map((item) => item.trim());
}

try {
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-agent-browser" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  // as an agent would: a browser of its own, with its own profile and a DevTools port the browser picks
  await paneSendText(pane, `'${chromePath()}' --headless=new --no-sandbox --remote-debugging-port=0 --user-data-dir='${profile}' --window-size=1000,700 'file://${PAGE}'\r`);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state") });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"] as const) {
      const tag = `${width}-${theme}`;
      await setPanel(origin, false);
      const off = await open(origin, pane, width, theme, {});
      assert.ok(!(await moreItems(off.page)).includes("Agent browser"), `${tag}: off by default, More offers no agent browser`);
      await off.close();
      console.log(`PASS ${tag}: off by default, More offers no agent browser`);

      await setPanel(origin, true);
      const on = await open(origin, pane, width, theme, {});
      await on.page.locator(".header-more-button").click();
      await on.page.locator(".row-menu, .row-sheet").getByText("Agent browser", { exact: true }).click();
      const panel = on.page.locator(width <= 480 ? '[role="dialog"].agent-browser' : ".file-panel.agent-browser");
      const frame = panel.locator("img.agent-browser-frame");
      await frame.waitFor().catch(async (error: unknown) => { await on.page.screenshot({ path: join(evidence ?? root, `agent-browser-missing-${tag}.png`) }); throw error; });
      await panel.locator(".agent-browser-url", { hasText: "shop.html" }).waitFor();
      const box = await frame.boundingBox();
      assert.ok(box !== null && box.width > 100 && box.height > 60, `${tag}: the page's frame is drawn at a readable size (${JSON.stringify(box)})`);
      if (width > 480) {
        const pane = await on.page.locator(".pane-column").boundingBox();
        assert.ok(pane !== null && box !== null && box.x >= pane.x + pane.width - 1, `${tag}: the panel stands beside the pane, not over it`);
      }
      await shot(on.page, `agent-browser-watch-${tag}`);
      console.log(`PASS ${tag}: More opens the pane's browser ${width <= 480 ? "as a sheet" : "beside the pane"} and shows its page`);

      const before = await agentTitle();
      await frame.click({ position: { x: 40, y: 40 } });
      // fixed wait: a click while only watching must reach nothing, and nothing proves an absence but time
      await Bun.sleep(700);
      assert.equal(await agentTitle(), before, `${tag}: a click before Take control does not reach the page`);
      await panel.getByRole("button", { name: "Take control", exact: true }).click();
      await panel.getByText("You have control. The agent may still act.", { exact: true }).waitFor();
      await frame.click({ position: { x: 40, y: 40 } });
      await titleBecomes(before === "ready" ? "clicked 1" : `clicked ${Number(before.split(" ")[1]) + 1}`);
      await shot(on.page, `agent-browser-control-${tag}`);
      await panel.getByRole("button", { name: "Stop", exact: true }).click();
      await panel.getByRole("button", { name: "Take control", exact: true }).waitFor();
      console.log(`PASS ${tag}: a click reaches the page only after Take control, and Stop hands control back`);
      if (width <= 480) {
        await on.page.goBack();
        await panel.waitFor({ state: "detached" });
        console.log(`PASS ${tag}: Back closes the sheet`);
      }
      assert.deepEqual(on.errors, [], `${tag}: no page errors`);
      await on.close();
    }
  }

} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace);
  // the agent's browser outlives its pane's shell when herdr closes it: end it by its own profile
  const found = Bun.spawn(["pgrep", "-f", profile], { stdout: "pipe" });
  for (const pid of (await new Response(found.stdout).text()).split("\n").filter((line) => line.trim() !== "")) process.kill(Number(pid));
  rmSync(root, { recursive: true, force: true });
}
