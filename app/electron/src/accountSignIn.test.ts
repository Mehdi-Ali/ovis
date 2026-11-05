import { expect, it } from "bun:test";
import { startLoopbackSignIn } from "./accountSignIn.ts";

it("hands back the callback's query once the browser returns, and stops listening", async () => {
  const signIn = await startLoopbackSignIn();
  expect(signIn.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const page = await fetch(`${signIn.redirectUri}?code=abc&state=s1`);
  expect(page.status).toBe(200);
  expect(await signIn.returned).toBe("code=abc&state=s1");
  await expect(fetch(`${signIn.redirectUri}?code=again&state=s1`)).rejects.toThrow();
});

it("turns away anything but the callback, and keeps waiting for it", async () => {
  const signIn = await startLoopbackSignIn();
  const origin = new URL(signIn.redirectUri).origin;
  expect((await fetch(`${origin}/`)).status).toBe(404);
  expect((await fetch(`${origin}/callback?code=no-state`)).status).toBe(404);
  await fetch(`${signIn.redirectUri}?error=access_denied&state=s2`);
  expect(await signIn.returned).toBe("error=access_denied&state=s2");
});

it("gives up a sign-in that a new one replaces", async () => {
  const first = await startLoopbackSignIn();
  const second = await startLoopbackSignIn();
  await expect(first.returned).rejects.toThrow("replaced");
  second.close();
});
