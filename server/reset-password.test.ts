import { expect, test } from "bun:test";
import { generateAdminPassword, resetAdminPassword, validAdminPassword } from "./reset-password";

function store() {
  const s = { hash: null as string | null, sessions: 3, setPasswordHash(h: string) { s.hash = h; }, revokeBrowserSessions() { const n = s.sessions; s.sessions = 0; return n; } };
  return s;
}

test("a generated password is strong, stored only as a hash, and signs browsers out", async () => {
  const s = store();
  const { password, browserSessionsRevoked } = await resetAdminPassword(s);
  expect(password).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(s.hash).not.toContain(password);
  expect(await Bun.password.verify(password, s.hash!)).toBe(true);
  expect(browserSessionsRevoked).toBe(3);
  expect(s.sessions).toBe(0);
  expect(generateAdminPassword()).not.toBe(generateAdminPassword());
});

test("a chosen password is used, and weak ones are refused before anything changes", async () => {
  const s = store();
  const { password } = await resetAdminPassword(s, "correct horse battery staple");
  expect(password).toBe("correct horse battery staple");
  const t = store();
  for (const bad of ["short", "x".repeat(1025), "sixteen chars ok\n!", "tab\there-and-long-enough"]) {
    await expect(resetAdminPassword(t, bad)).rejects.toThrow("16–1024 printable");
  }
  expect(t.hash).toBeNull();
  expect(t.sessions).toBe(3);
  expect(validAdminPassword("p".repeat(16))).toBe(true);
});
