import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { version } from "../package.json";
import { binaryName, stageServerArtifact } from "./server-artifact.ts";
import type { ServerPlatform } from "./server-manifest.ts";

// node-pty's package for this PC is installed, so nothing is downloaded; the compile is stood in for (the integration
// lane's server/compiled-server.contract.test.ts runs a real one)
const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}` as ServerPlatform;
const root = mkdtempSync(join(tmpdir(), "ovis-artifact-"));
const dir = join(root, "server");
const files = (): string[] => [...new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })].map((path) => path.replaceAll("\\", "/"));

beforeAll(async () => {
  const dist = join(root, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<!doctype html>");
  const host = join(root, "ovis-pty-sidecar");
  writeFileSync(host, "rust host");
  writeFileSync(`${host}.json`, JSON.stringify({ crate: "c".repeat(40), sha256: "stale", version: "0.0.1" }));
  await stageServerArtifact({ platform, dir, nodePty: true, dist, ptySidecar: { binary: host, record: `${host}.json` }, build: async (_platform, outfile) => writeFileSync(outfile, "binary") });
}, 60_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the folder that runs the compiled server", () => {
  it("holds the binary, the client and what runs beside it, and no server or shared source", () => {
    const all = files();
    expect(all).toContain(binaryName(platform));
    expect(all).toContain("dist/index.html");
    expect(all).toContain("pty-host.mjs");
    expect(all).toContain("pty-smoke.mjs");
    expect(all).toContain("node_modules/@lydell/node-pty/package.json");
    expect(all.some((path) => path.startsWith("node_modules/@lydell/node-pty-") && path.endsWith("/pty.node"))).toBe(true);
    expect(all.filter((path) => path.startsWith("server/") || path.startsWith("shared/"))).toEqual([]);
    expect(all.filter((path) => path.endsWith(".ts"))).toEqual([]);
  });

  it("vouches for the Rust PTY host with the version compiled into the binary, and its bytes", () => {
    const record = JSON.parse(readFileSync(join(dir, "bin", "ovis-pty-sidecar.json"), "utf8")) as Record<string, unknown>;
    expect(record).toEqual({ crate: "c".repeat(40), sha256: createHash("sha256").update("rust host").digest("hex"), version });
  });

  it("installs an agent integration from what it carries, with no source to build it from", () => {
    expect(existsSync(join(dir, "integrations", "gjc.js"))).toBe(true);
    // what the installer copies is the built file beside it, which this marker proves
    writeFileSync(join(dir, "integrations", "gjc.js"), "export default function extension() {} // built beside the binary\n");
    const home = join(root, "home");
    mkdirSync(home);
    const run = Bun.spawnSync([process.execPath, join(dir, "scripts", "install-gjc-integration.js")], { cwd: dir, env: { ...process.env, HOME: home, USERPROFILE: home }, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    const installed = readFileSync(join(home, ".gjc", "agent", "extensions", "herdr-web-ui.js"), "utf8");
    expect(installed).toContain("built beside the binary");
    expect(existsSync(join(dir, "scripts", "install-pi-integration.js"))).toBe(true);
  });
});
