import { cookieValue, hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";
import { isSettingName, type ServerSettings } from "./server-settings";
import type { StepUpGrants } from "./step-up";

export interface ServerSettingsRouteDependencies {
  cookieName: string;
  origin: string;
  checkBrowserSession: (token: string | null) => boolean;
  settings: ServerSettings;
  grants: StepUpGrants;
  stepUp: {
    hasPasskey: () => boolean;
    options: () => Promise<unknown>;
    verifyPasskey: (challengeId: unknown, response: unknown) => Promise<boolean>;
    verifyPassword: (password: string) => Promise<boolean>;
  };
  rateLimited: (key: string) => boolean;
}

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: PRIVATE_NO_STORE_HEADERS });

/** Settings → Server settings. Browser sessions only: a CLI or connector token can never change these. */
export async function handleServerSettingsRoute(req: Request, deps: ServerSettingsRouteDependencies): Promise<Response | null> {
  const path = new URL(req.url).pathname;
  if (path !== "/api/server-settings" && !path.startsWith("/api/server-settings/")) return null;
  if (!hasBrowserSession(req, deps.cookieName, deps.checkBrowserSession)) return json({ error: "Web session required." }, 401);
  const session = cookieValue(req, deps.cookieName);

  if (path === "/api/server-settings" && req.method === "GET") {
    return json({
      settings: deps.settings.describe(),
      channelAvailable: deps.settings.channelAvailable(),
      stepUp: deps.stepUp.hasPasskey() ? "passkey" : "password",
    });
  }
  if (path === "/api/server-settings/step-up/options" && req.method === "GET") {
    if (!deps.stepUp.hasPasskey()) return json({ error: "No passkey is registered; confirm with the admin password." }, 409);
    return json(await deps.stepUp.options());
  }
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (req.headers.get("origin") !== deps.origin) return json({ error: "Same-origin request required." }, 403);
  const body = await req.json().then((value): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {}).catch(() => ({} as Record<string, unknown>));

  if (path === "/api/server-settings/step-up") {
    if (deps.rateLimited(`step-up:${session}`)) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
    const verified = deps.stepUp.hasPasskey()
      ? await deps.stepUp.verifyPasskey(body.challengeId, body.response)
      : typeof body.password === "string" && await deps.stepUp.verifyPassword(body.password);
    if (!verified) return json({ error: deps.stepUp.hasPasskey() ? "Passkey check failed." : "Wrong password." }, 401);
    return json({ grant: deps.grants.issue(session!) });
  }

  if (path !== "/api/server-settings") return json({ error: "Not found" }, 404);
  const name = body.name;
  if (!isSettingName(name)) return json({ error: "Unknown setting." }, 422);
  // Turning agent prompts off (or back on) needs the operator to confirm again first.
  if (name === "agentPermissions" && !deps.grants.consume(body.grant, session)) {
    return json({ error: "Confirm with your passkey before changing agent permissions." }, 403);
  }
  if (body.reset === true) {
    deps.settings.reset(name);
    return json({ ok: true, setting: deps.settings.describe()[name] });
  }
  const result = deps.settings.set(name, body.value);
  return result.ok ? json({ ok: true, setting: deps.settings.describe()[name] }) : json({ error: result.error }, 422);
}
