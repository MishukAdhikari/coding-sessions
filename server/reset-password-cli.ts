/**
 * Sets a new admin password and signs out every browser. Run as the instance's service
 * account with its environment, by `coding-sessions reset-password`. The password goes to
 * stdout only; with --stdin it is read from standard input instead of being generated.
 */
import { db, setMeta } from "./db";
import { resetAdminPassword } from "./reset-password";

const args = process.argv.slice(2);
const chosen = args.includes("--stdin") ? (await Bun.stdin.text()).replace(/\r?\n$/, "") : undefined;
try {
  const { password, browserSessionsRevoked } = await resetAdminPassword({
    setPasswordHash: (hash) => setMeta("admin_password_hash", hash),
    revokeBrowserSessions: () => db.query("DELETE FROM auth_sessions").run().changes,
  }, chosen);
  setMeta("admin_password_reset_at", String(Date.now()));
  console.log(args.includes("--json") ? JSON.stringify({ password }) : password);
  console.error(`Signed out ${browserSessionsRevoked} browser session(s). Passkeys and CLI tokens keep working.`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
