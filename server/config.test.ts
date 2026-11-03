import { expect, test } from "bun:test";
import { readConfig } from "./config";
import { childEnvironment } from "./child-env";

test("fresh configuration is portable and uses ordinary agent permissions", () => {
  expect(readConfig({})).toMatchObject({ port: 9121, origin: "http://localhost:9121", rpId: "localhost", unrestrictedAgents: false, repository: "", repoOwners: [] });
  expect(readConfig({ ORIGIN: "https://sessions.example.com" }).rpId).toBe("sessions.example.com");
});
test("rejects unsafe origins, wrong RP IDs, weak public cookies and invalid paths", () => {
  for (const origin of ["http://public.example", "https://user:pass@example.com", "https://example.com/path", "https://example.com?q=x", "ftp://example.com"]) {
    expect(() => readConfig({ ORIGIN: origin })).toThrow();
  }
  expect(() => readConfig({ ORIGIN: "https://sessions.example.com", RP_ID: "other.example" })).toThrow();
  expect(() => readConfig({ ORIGIN: "https://sessions.example.com", COOKIE_SECURE: "0" })).toThrow();
  expect(() => readConfig({ PORT: "invalid" })).toThrow();
  expect(() => readConfig({ CS_DATA_DIR: "relative" })).toThrow();
  expect(() => readConfig({ CS_AGENT_PERMISSIONS: "yes" })).toThrow();
});
test("agent environment excludes app secrets, arbitrary cloud tokens and runtime injection", () => {
  const source = { HOME: "/srv/user", PATH: "/usr/bin", ZMX_DIR: "/srv/user/.zmx", LC_ALL: "C.UTF-8",
    AWS_SECRET_ACCESS_KEY: "cloud-secret", ADMIN_PASSWORD: "app-secret", NODE_OPTIONS: "--require attack",
    CREDENTIALS_DIRECTORY: "/run/credentials/app", CS_TOKEN_KEY_FILE: "/etc/key" };
  expect(childEnvironment({ AGENT_TOKEN: "selected-only" }, source)).toEqual({ HOME: "/srv/user", PATH: "/usr/bin", ZMX_DIR: "/srv/user/.zmx", LC_ALL: "C.UTF-8", AGENT_TOKEN: "selected-only" });
  expect(childEnvironment({}, { ...source, CS_PASSTHROUGH_ENV: "HTTPS_PROXY", HTTPS_PROXY: "http://proxy:8080" }).HTTPS_PROXY).toBe("http://proxy:8080");
  expect(childEnvironment({}, { ...source, CS_CHILD_ENV: "inherit" }).CREDENTIALS_DIRECTORY).toBeUndefined();
});
