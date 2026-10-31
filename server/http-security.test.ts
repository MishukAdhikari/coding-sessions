import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePublicFile, requestClientIp, allowsApiMutation } from "./http-security";

test("static files cannot traverse, expose dotfiles, or escape through symlinks", () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "xs-static-"));
  try {
    const pub = join(dir, "public"); mkdirSync(pub);
    writeFileSync(join(pub, "index.html"), "safe");
    writeFileSync(join(pub, ".env"), "fixture");
    writeFileSync(join(dir, "private.txt"), "fixture");
    symlinkSync(join(dir, "private.txt"), join(pub, "link.txt"));
    symlinkSync(join(pub, ".env"), join(pub, "alias.txt"));
    expect(resolvePublicFile(pub, "/alias.txt")).toBeNull();
    expect(resolvePublicFile(pub, "/")).toBe(join(pub, "index.html"));
    for (const path of ["/.env", "/%2eenv", "/../private.txt", "/%2e%2e/private.txt", "/link.txt", "/%00", "/%zz", "/\private.txt"]) {
      expect(resolvePublicFile(pub, path)).toBeNull();
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("only explicitly trusted loopback proxies may supply the rate-limit address", () => {
  const req = new Request("http://localhost", { headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.8" } });
  expect(requestClientIp(req, "127.0.0.1", false)).toBe("127.0.0.1");
  expect(requestClientIp(req, "198.51.100.1", true)).toBe("198.51.100.1");
  expect(requestClientIp(req, "127.0.0.1", true)).toBe("203.0.113.7");
  expect(requestClientIp(new Request("http://localhost", { headers: { "x-real-ip": "not-an-ip" } }), "::1", true)).toBe("::1");
});


test("API mutations reject cross-origin and originless cookie requests while preserving bearer clients", () => {
  const origin = "https://sessions.example.test";
  const allowed = (method: string, headers: Record<string, string>) => allowsApiMutation(new Request(origin + "/api/terminal", { method, headers }), origin, "xs_auth");
  for (const method of ["POST", "DELETE", "PUT", "PATCH"]) {
    expect(allowed(method, { cookie: "xs_auth=fixture", origin })).toBe(true);
    expect(allowed(method, { cookie: "xs_auth=fixture", origin: "https://other.example.test" })).toBe(false);
    expect(allowed(method, { cookie: "xs_auth=fixture" })).toBe(false);
    expect(allowed(method, { cookie: "xs_auth=fixture", authorization: "Bearer fake" })).toBe(false);
    expect(allowed(method, { authorization: "Bearer fixture" })).toBe(true);
    expect(allowed(method, { origin: "null" })).toBe(false);
  }
  expect(allowed("GET", { cookie: "xs_auth=fixture" })).toBe(true);
});
