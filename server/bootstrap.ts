import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProtectedSecret } from "./secrets";

/** The password itself never goes to stdout, argv or the service environment. */
export function bootstrapPassword(dataDir: string, env: Record<string, string | undefined> = process.env) {
  const configured = env.XCS_ADMIN_PASSWORD_FILE || (env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, "admin-password") : null);
  const path = configured || join(dataDir, "bootstrap-password");
  if (!configured && !existsSync(path)) writeFileSync(path, randomBytes(24).toString("base64url") + "\n", { mode: 0o600, flag: "wx" });
  const password = readProtectedSecret(path).trim();
  if (password.length < 16 || password.length > 1024 || /[\x00-\x1f\x7f]/.test(password)) throw new Error("Bootstrap password must contain 16–1024 printable characters.");
  return { password, path };
}
