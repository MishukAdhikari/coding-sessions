import { expect, test } from "bun:test";
import { readCsSetting } from "./environment";
import { readConfig } from "./config";
import { childEnvironment } from "./child-env";
import { matchesCodexLaunchMarkers } from "./codex-startup";

test("CS configuration overrides legacy settings without mixing up unrelated keys", () => {
  expect(readCsSetting({ CS_DATA_DIR: "/new", XCS_DATA_DIR: "/old" }, "CS_DATA_DIR")).toBe("/new");
  expect(readCsSetting({ XCS_DATA_DIR: "/old" }, "CS_DATA_DIR")).toBe("/old");
  expect(readCsSetting({ CS_DEFAULT_REPO: "", XCS_DEFAULT_REPO: "legacy/repo" }, "CS_DEFAULT_REPO")).toBe("");
  expect(readConfig({ XCS_AGENT_PERMISSIONS: "unrestricted", XCS_TRUST_PROXY: "1" })).toMatchObject({ unrestrictedAgents: true, trustProxy: true });
  expect(readConfig({ CS_AGENT_PERMISSIONS: "standard", XCS_AGENT_PERMISSIONS: "unrestricted" }).unrestrictedAgents).toBe(false);
});

test("both generations of credential pointers remain absent from child environments", () => {
  for (const mode of ["filtered", "inherit"]) {
    const env = childEnvironment({}, { CS_CHILD_ENV: mode, CS_PASSTHROUGH_ENV: "CS_TOKEN_KEY_FILE,XCS_TOKEN_KEY_FILE",
      CS_TOKEN_KEY_FILE: "/new/key", XCS_TOKEN_KEY_FILE: "/old/key", CS_ADMIN_PASSWORD_FILE: "/new/pass", XCS_ADMIN_PASSWORD_FILE: "/old/pass" });
    for (const name of ["CS_TOKEN_KEY_FILE", "XCS_TOKEN_KEY_FILE", "CS_ADMIN_PASSWORD_FILE", "XCS_ADMIN_PASSWORD_FILE"]) expect(env[name]).toBeUndefined();
  }
});

test("live legacy Codex processes remain attributable but mixed marker families are rejected", () => {
  const old = "XCS_LAUNCH_ID=launch\0XCS_SCREEN=cs-demo\0XCS_DB_PATH=/data/app.db\0";
  expect(matchesCodexLaunchMarkers(old, "launch", "cs-demo", "/data/app.db")).toBe(true);
  expect(matchesCodexLaunchMarkers(old + "CS_LAUNCH_ID=new\0", "launch", "cs-demo", "/data/app.db")).toBe(false);
});
