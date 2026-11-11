/**
 * Admin password reset for `sudo coding-sessions reset-password`. Root runs it as the
 * service account against the instance database, the way `setup-link` mints its link.
 * It replaces the password hash and signs out every browser. Passkeys, CLI tokens and
 * MCP OAuth tokens stay: each was granted separately and has its own revocation.
 */
import { randomBytes } from "node:crypto";

export interface ResetPasswordStore {
  setPasswordHash(hash: string): void;
  /** Deletes every browser cookie session; returns how many there were. */
  revokeBrowserSessions(): number;
}

export function validAdminPassword(password: string): boolean {
  return password.length >= 16 && password.length <= 1024 && !/[\x00-\x1f\x7f]/.test(password);
}

export function generateAdminPassword(): string {
  return randomBytes(24).toString("base64url");
}

export async function resetAdminPassword(store: ResetPasswordStore, chosen?: string, hash = (p: string) => Bun.password.hash(p)) {
  const password = chosen ?? generateAdminPassword();
  if (!validAdminPassword(password)) throw new Error("The password must contain 16–1024 printable characters.");
  store.setPasswordHash(await hash(password));
  return { password, browserSessionsRevoked: store.revokeBrowserSessions() };
}
