import { expect, test } from "bun:test";
import { readCsSetting } from "./environment";
import { readConfig } from "./config";
import { childEnvironment } from "./child-env";
import { matchesCodexLaunchMarkers } from "./codex-startup";

test("CS configuration is read exactly as set", () => {
  expect(readCsSetting({ CS_DATA_DIR: "/new" }, "CS_DATA_DIR")).toBe("/new");
  expect(readCsSetting({}, "CS_DATA_DIR")).toBeUndefined();
  expect(readCsSetting({ CS_DEFAULT_REPO: "" }, "CS_DEFAULT_REPO")).toBe("");
  expect(readConfig({ CS_AGENT_PERMISSIONS: "unrestricted", CS_TRUST_PROXY: "1" })).toMatchObject({ unrestrictedAgents: true, trustProxy: true });
});

test("credential pointers stay absent from child environments", () => {
  for (const mode of ["filtered", "inherit"]) {
    const env = childEnvironment({}, { CS_CHILD_ENV: mode, CS_PASSTHROUGH_ENV: "CS_TOKEN_KEY_FILE",
      CS_TOKEN_KEY_FILE: "/new/key", CS_ADMIN_PASSWORD_FILE: "/new/pass" });
    for (const name of ["CS_TOKEN_KEY_FILE", "CS_ADMIN_PASSWORD_FILE"]) expect(env[name]).toBeUndefined();
  }
});

test("Codex processes are attributed only by one complete marker set", () => {
  const markers = "CS_LAUNCH_ID=launch\0CS_SCREEN=cs-demo\0CS_DB_PATH=/data/app.db\0";
  expect(matchesCodexLaunchMarkers(markers, "launch", "cs-demo", "/data/app.db")).toBe(true);
  expect(matchesCodexLaunchMarkers(markers + "CS_LAUNCH_ID=new\0", "launch", "cs-demo", "/data/app.db")).toBe(false);
});
