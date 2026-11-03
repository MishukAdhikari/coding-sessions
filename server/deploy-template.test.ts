import { expect, test } from "bun:test";

test("the bundled nginx template keeps OAuth callback codes out of the access log, and only there", async () => {
  const template = await Bun.file(new URL("../deploy/templates/nginx.conf", import.meta.url)).text();
  const blocks = [...template.matchAll(/location\s+(=\s+)?(\S+)\s*\{([^}]*)\}/g)].map(m => ({ exact: !!m[1], path: m[2], body: m[3]! }));
  const callback = blocks.find(b => b.exact && b.path === "/oauth/connectors/callback");
  const root = blocks.find(b => !b.exact && b.path === "/");
  expect(callback).toBeDefined();
  expect(callback!.body).toContain("access_log off;");
  expect(callback!.body).toContain("error_log /dev/null;");
  // Same upstream and forwarding headers as the main location.
  for (const line of ["proxy_pass http://127.0.0.1:@PORT@;", "proxy_set_header Host $host;", "proxy_set_header X-Forwarded-Proto $scheme;", "proxy_set_header X-Real-IP $remote_addr;"]) {
    expect(callback!.body).toContain(line);
    expect(root!.body).toContain(line);
  }
  expect(root!.body).not.toContain("access_log off");
  expect(root!.body).not.toContain("error_log");
  expect(template.match(/access_log off/g)!.length).toBe(1);
  expect(template.match(/error_log/g)!.length).toBe(1);
});
