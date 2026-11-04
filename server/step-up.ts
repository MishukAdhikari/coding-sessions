import { createHash, randomBytes } from "node:crypto";

/**
 * Short-lived proof that the signed-in operator just re-confirmed with a passkey
 * (or the admin password when no passkey exists). A grant belongs to the browser
 * session that earned it and is spent by the first change that uses it.
 */
export function createStepUpGrants(options: { ttlMs?: number; now?: () => number } = {}) {
  const ttlMs = options.ttlMs ?? 2 * 60 * 1000;
  const now = options.now ?? Date.now;
  const grants = new Map<string, { session: string; expiresAt: number }>();
  const sessionKey = (token: string) => createHash("sha256").update(token).digest("hex");

  return {
    issue(sessionToken: string): string {
      for (const [id, grant] of grants) if (grant.expiresAt <= now()) grants.delete(id);
      const id = randomBytes(24).toString("base64url");
      grants.set(id, { session: sessionKey(sessionToken), expiresAt: now() + ttlMs });
      return id;
    },
    consume(grantId: unknown, sessionToken: string | null): boolean {
      if (typeof grantId !== "string" || !sessionToken) return false;
      const grant = grants.get(grantId);
      grants.delete(grantId);
      return !!grant && grant.expiresAt > now() && grant.session === sessionKey(sessionToken);
    },
  };
}

export type StepUpGrants = ReturnType<typeof createStepUpGrants>;
