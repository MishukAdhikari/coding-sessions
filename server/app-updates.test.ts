import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appUpdatePaths, createAppUpdates, parseUpdateStatus } from "./app-updates";
import { handleAppUpdatesRoute } from "./app-updates-route";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "cs-app-updates-")); dirs.push(dir); return dir; };

test("hosts without the installer's updater report automatic updates as unavailable", async () => {
  const dir = temp();
  const updates = createAppUpdates(appUpdatePaths(dir, {}));
  expect(await updates.status()).toMatchObject({ available: false, enabled: false, last: null });
  expect(await updates.setEnabled(true)).toMatchObject({ ok: false });
  expect(existsSync(join(dir, "app-auto-update"))).toBe(false);
});

test("turning automatic updates on writes a private opt-in, and off removes it", async () => {
  const dir = temp();
  const status = join(dir, "status.json");
  const updates = createAppUpdates({ ...appUpdatePaths(dir, { CS_APP_UPDATE_STATUS: status }), version: join(dir, "missing") });
  expect(await updates.setEnabled(true)).toEqual({ ok: true });
  expect(readFileSync(join(dir, "app-auto-update"), "utf8")).toBe("on\n");
  expect(statSync(join(dir, "app-auto-update")).mode & 0o777).toBe(0o600);
  expect(await updates.status()).toMatchObject({ available: true, enabled: true, channel: "releases" });
  await updates.setEnabled(false);
  expect(await updates.status()).toMatchObject({ enabled: false });
});

test("the updater's last result is read back, and anything malformed is ignored", async () => {
  const dir = temp();
  const status = join(dir, "status.json");
  const version = join(dir, "version");
  writeFileSync(version, "v0.3.0\n");
  writeFileSync(status, JSON.stringify({ started: "2026-11-03T04:00:00Z", finished: "2026-11-03T04:01:00Z", result: "success", message: "Updated to v0.3.0.", version: "v0.3.0", channel: "releases" }));
  const updates = createAppUpdates({ ...appUpdatePaths(dir, { CS_APP_UPDATE_STATUS: status }), version });
  expect(await updates.status()).toMatchObject({ version: "v0.3.0", last: { result: "success", message: "Updated to v0.3.0.", finished: "2026-11-03T04:01:00.000Z" } });
  writeFileSync(status, "not json");
  expect((await updates.status()).last).toBeNull();
  expect(parseUpdateStatus({ result: "pwned", finished: "2026-11-03T04:01:00Z" })).toBeNull();
  expect(parseUpdateStatus({ result: "failed", finished: "yesterday" })).toBeNull();
});

test("the route needs a browser session, same origin, and a boolean", async () => {
  const calls: boolean[] = [];
  const deps = {
    cookieName: "cs", origin: "https://sessions.example.com",
    checkBrowserSession: (token: string | null) => token === "good",
    controller: { status: async () => ({ available: true }) as never, setEnabled: async (on: boolean) => { calls.push(on); return { ok: true as const }; } },
  };
  const request = (init: RequestInit & { cookie?: string } = {}) => new Request("https://sessions.example.com/api/app-updates", {
    ...init, headers: { cookie: init.cookie ?? "cs=good", origin: "https://sessions.example.com", ...(init.headers ?? {}) },
  });
  expect(await handleAppUpdatesRoute(new Request("https://sessions.example.com/api/other"), deps)).toBeNull();
  expect((await handleAppUpdatesRoute(request({ cookie: "cs=bad" }), deps))!.status).toBe(401);
  expect((await handleAppUpdatesRoute(request(), deps))!.status).toBe(200);
  expect((await handleAppUpdatesRoute(request({ method: "POST", body: "{}" }), deps))!.status).toBe(422);
  expect((await handleAppUpdatesRoute(request({ method: "POST", body: JSON.stringify({ enabled: true }), headers: { origin: "https://evil.example" } }), deps))!.status).toBe(403);
  expect((await handleAppUpdatesRoute(request({ method: "POST", body: JSON.stringify({ enabled: true }) }), deps))!.status).toBe(200);
  expect(calls).toEqual([true]);
});

test("the panel reports the channel chosen in Settings, not just the startup value", async () => {
  const dir = temp();
  let channel = "releases";
  const updates = createAppUpdates({ ...appUpdatePaths(dir, { CS_APP_UPDATE_STATUS: join(dir, "status.json") }), version: join(dir, "missing") }, () => channel);
  expect((await updates.status()).channel).toBe("releases");
  channel = "main";
  expect((await updates.status()).channel).toBe("main");
});
