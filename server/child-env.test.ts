import { expect, test } from "bun:test";
import { childEnvironment } from "./child-env";

test("agent processes inherit runtime paths but not service credentials or unrelated tokens", () => {
  const env = childEnvironment({ PROVIDER_KEY: "provider-test-value" }, {
    HOME: "/var/lib/test", PATH: "/usr/bin", SCREENDIR: "/var/lib/test/run/screen", LC_ALL: "C",
    CREDENTIALS_DIRECTORY: "/run/credentials/test", XCS_TOKEN_KEY_FILE: "/private/key",
    XCS_ADMIN_PASSWORD_FILE: "/private/password", OTHER_API_TOKEN: "test-only",
  });
  expect(env).toEqual({ HOME: "/var/lib/test", PATH: "/usr/bin", SCREENDIR: "/var/lib/test/run/screen", LC_ALL: "C", PROVIDER_KEY: "provider-test-value" });
});

test("explicit compatibility and passthrough never bulk-forward app credential paths", () => {
  for (const settings of [{ XCS_CHILD_ENV: "inherit" }, { XCS_PASSTHROUGH_ENV: "OTHER_API_TOKEN,CREDENTIALS_DIRECTORY" }]) {
    const env = childEnvironment({}, { ...settings, OTHER_API_TOKEN: "test-only", CREDENTIALS_DIRECTORY: "/private" });
    expect(env.OTHER_API_TOKEN).toBe("test-only");
    expect(env.CREDENTIALS_DIRECTORY).toBeUndefined();
  }
  expect(() => childEnvironment({}, { XCS_CHILD_ENV: "typo" })).toThrow();
  expect(() => childEnvironment({}, { XCS_PASSTHROUGH_ENV: "bad-name" })).toThrow();
});
