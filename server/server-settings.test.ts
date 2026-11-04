import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerSettings, isSettingName } from "./server-settings";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => { data.set(k, v); }, delete: (k: string) => { data.delete(k); } };
}

test("a value resolves from Settings, else the server's environment, else the built-in default", () => {
  const store = memoryStore();
  const settings = createServerSettings({ store, env: { CS_DEFAULT_REPO: "acme/app" } });
  expect(settings.describe().defaultRepo).toEqual({ value: "acme/app", source: "server", serverValue: "acme/app" });
  expect(settings.describe().agentPermissions).toEqual({ value: "standard", source: "default", serverValue: "standard" });
  expect(settings.set("defaultRepo", " acme/other ")).toEqual({ ok: true, value: "acme/other" });
  expect(settings.describe().defaultRepo).toEqual({ value: "acme/other", source: "settings", serverValue: "acme/app" });
  settings.reset("defaultRepo");
  expect(settings.get("defaultRepo")).toBe("acme/app");
  expect(store.data.size).toBe(0);
});

test("saved values survive a restart and invalid saved values are ignored", () => {
  const store = memoryStore({ "server_setting:agentPermissions": "unrestricted", "server_setting:defaultRepo": "not a repo" });
  const settings = createServerSettings({ store, env: { CS_DEFAULT_REPO: "acme/app" } });
  expect(settings.unrestricted()).toBe(true);
  expect(settings.get("defaultRepo")).toBe("acme/app");
});

test("validation matches the server's own rules", () => {
  const settings = createServerSettings({ store: memoryStore(), env: {} });
  expect(settings.set("defaultRepo", "no-slash")).toEqual({ ok: false, error: "Default repository must be owner/repository." });
  expect(settings.set("githubOwners", "good, bad owner")).toMatchObject({ ok: false });
  expect(settings.set("claudeAiEmail", "not-an-email")).toMatchObject({ ok: false });
  expect(settings.set("agentPermissions", "yolo")).toMatchObject({ ok: false });
  expect(settings.set("terminalMouse", "maybe")).toMatchObject({ ok: false });
  expect(settings.set("defaultRepo", 42)).toMatchObject({ ok: false });
  expect(settings.set("defaultRepo", "")).toEqual({ ok: true, value: "" });
  expect(settings.set("githubOwners", " acme , beta,acme ")).toEqual({ ok: true, value: "acme,beta" });
  expect(settings.owners()).toEqual(["acme", "beta"]);
});

test("terminal mouse keeps the old rule: only off turns it off", () => {
  expect(createServerSettings({ store: memoryStore(), env: {} }).mouseEnabled()).toBe(true);
  expect(createServerSettings({ store: memoryStore(), env: { CS_TERM_MOUSE: "off" } }).mouseEnabled()).toBe(false);
  expect(createServerSettings({ store: memoryStore(), env: { CS_TERM_MOUSE: "anything" } }).mouseEnabled()).toBe(true);
  const settings = createServerSettings({ store: memoryStore(), env: {} });
  settings.set("terminalMouse", "off");
  expect(settings.mouseEnabled()).toBe(false);
});

test("the update channel is written for the root updater, and only where one exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-settings-")); dirs.push(dir);
  const file = join(dir, "app-update-channel");
  const settings = createServerSettings({ store: memoryStore(), env: {}, channelFile: file });
  expect(settings.set("updateChannel", "main")).toEqual({ ok: true, value: "main" });
  expect(readFileSync(file, "utf8")).toBe("main\n");
  settings.reset("updateChannel");
  expect(existsSync(file)).toBe(false);
  const noUpdater = createServerSettings({ store: memoryStore(), env: {} });
  expect(noUpdater.channelAvailable()).toBe(false);
  expect(noUpdater.set("updateChannel", "main")).toMatchObject({ ok: false });
});

test("changes are announced so dependent caches can be cleared", () => {
  const changed: string[] = [];
  const settings = createServerSettings({ store: memoryStore(), env: {}, onChange: (name) => changed.push(name) });
  settings.set("githubOwners", "acme");
  settings.reset("githubOwners");
  settings.set("githubOwners", "bad owner");
  expect(changed).toEqual(["githubOwners", "githubOwners"]);
  expect(isSettingName("githubOwners")).toBe(true);
  expect(isSettingName("ORIGIN")).toBe(false);
});
