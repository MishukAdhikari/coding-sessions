import { expect, test } from "bun:test";
import { createServerSettings } from "./server-settings";
import { createStepUpGrants } from "./step-up";
import { handleServerSettingsRoute, type ServerSettingsRouteDependencies } from "./server-settings-route";

const ORIGIN = "https://sessions.example.com";

function setup(over: Partial<ServerSettingsRouteDependencies["stepUp"]> = {}) {
  const data = new Map<string, string>();
  const settings = createServerSettings({
    store: { get: (k) => data.get(k) ?? null, set: (k, v) => { data.set(k, v); }, delete: (k) => { data.delete(k); } },
    env: { CS_DEFAULT_REPO: "acme/app" },
  });
  const deps: ServerSettingsRouteDependencies = {
    cookieName: "cs", origin: ORIGIN,
    checkBrowserSession: (token) => token === "good" || token === "other",
    settings, grants: createStepUpGrants(),
    stepUp: {
      hasPasskey: () => true,
      options: async () => ({ challengeId: "c1", options: {} }),
      verifyPasskey: async (challengeId) => challengeId === "c1",
      verifyPassword: async (password) => password === "admin-pass",
      ...over,
    },
    rateLimited: () => false,
  };
  const call = (path: string, init: { method?: string; body?: unknown; cookie?: string; origin?: string; bearer?: boolean } = {}) =>
    handleServerSettingsRoute(new Request(`${ORIGIN}${path}`, {
      method: init.method ?? "GET",
      headers: {
        ...(init.bearer ? { authorization: "Bearer cs_token" } : { cookie: `cs=${init.cookie ?? "good"}` }),
        origin: init.origin ?? ORIGIN, "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }), deps);
  return { call, settings };
}

test("unrelated paths fall through; only browser sessions get in", async () => {
  const { call } = setup();
  expect(await call("/api/settings")).toBeNull();
  expect((await call("/api/server-settings", { bearer: true }))!.status).toBe(401);
  expect((await call("/api/server-settings", { cookie: "stolen" }))!.status).toBe(401);
});

test("reading shows each value, where it comes from, and how to confirm sensitive changes", async () => {
  const { call } = setup();
  const body: any = await (await call("/api/server-settings"))!.json();
  expect(body.settings.defaultRepo).toEqual({ value: "acme/app", source: "server", serverValue: "acme/app" });
  expect(body).toMatchObject({ channelAvailable: false, stepUp: "passkey" });
});

test("a valid change is saved, an invalid one is refused, and reset goes back to the server value", async () => {
  const { call, settings } = setup();
  const saved = await call("/api/server-settings", { method: "POST", body: { name: "defaultRepo", value: "acme/other" } });
  expect(saved!.status).toBe(200);
  expect(settings.get("defaultRepo")).toBe("acme/other");
  const bad = await call("/api/server-settings", { method: "POST", body: { name: "defaultRepo", value: "nope" } });
  expect(bad!.status).toBe(422);
  expect((await call("/api/server-settings", { method: "POST", body: { name: "ORIGIN", value: "x" } }))!.status).toBe(422);
  await call("/api/server-settings", { method: "POST", body: { name: "defaultRepo", reset: true } });
  expect(settings.describe().defaultRepo.source).toBe("server");
});

test("changes need the app's own origin", async () => {
  const { call, settings } = setup();
  const res = await call("/api/server-settings", { method: "POST", origin: "https://evil.example", body: { name: "defaultRepo", value: "acme/x" } });
  expect(res!.status).toBe(403);
  expect(settings.get("defaultRepo")).toBe("acme/app");
});

test("the permission mode changes only with a fresh, single-use passkey confirmation from the same session", async () => {
  const { call, settings } = setup();
  const change = (grant?: string, cookie?: string) =>
    call("/api/server-settings", { method: "POST", cookie, body: { name: "agentPermissions", value: "unrestricted", grant } });
  expect((await change())!.status).toBe(403);
  expect((await call("/api/server-settings/step-up", { method: "POST", body: { challengeId: "wrong" } }))!.status).toBe(401);
  const { grant }: any = await (await call("/api/server-settings/step-up", { method: "POST", body: { challengeId: "c1" } }))!.json();
  expect((await change(grant, "other"))!.status).toBe(403);
  const { grant: fresh }: any = await (await call("/api/server-settings/step-up", { method: "POST", body: { challengeId: "c1" } }))!.json();
  expect((await change(fresh))!.status).toBe(200);
  expect(settings.unrestricted()).toBe(true);
  expect((await change(fresh))!.status).toBe(403);
});

test("without a passkey the admin password confirms instead, and never when a passkey exists", async () => {
  const noPasskey = setup({ hasPasskey: () => false });
  expect((await noPasskey.call("/api/server-settings/step-up/options"))!.status).toBe(409);
  expect((await noPasskey.call("/api/server-settings/step-up", { method: "POST", body: { password: "wrong" } }))!.status).toBe(401);
  const ok = await noPasskey.call("/api/server-settings/step-up", { method: "POST", body: { password: "admin-pass" } });
  expect(((await ok!.json()) as any).grant).toBeString();
  const withPasskey = setup();
  expect((await withPasskey.call("/api/server-settings/step-up", { method: "POST", body: { password: "admin-pass" } }))!.status).toBe(401);
});

test("repeated confirmation attempts are rate limited", async () => {
  const { settings } = setup();
  const res = await handleServerSettingsRoute(new Request(`${ORIGIN}/api/server-settings/step-up`, {
    method: "POST", headers: { cookie: "cs=good", origin: ORIGIN }, body: JSON.stringify({ challengeId: "c1" }),
  }), {
    cookieName: "cs", origin: ORIGIN, checkBrowserSession: () => true, settings, grants: createStepUpGrants(),
    stepUp: { hasPasskey: () => true, options: async () => ({}), verifyPasskey: async () => true, verifyPassword: async () => true },
    rateLimited: () => true,
  });
  expect(res!.status).toBe(429);
});
