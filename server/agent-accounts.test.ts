import { expect, test } from "bun:test";
import { createAgentAccounts, parseAccount, type AccountDependencies } from "./agent-accounts";
import { handleAgentAccountsRoute } from "./agent-accounts-route";

function harness(overrides: Partial<AccountDependencies> = {}) {
  const calls: string[] = [];
  let loggedIn = true;
  const deps: AccountDependencies = {
    which: () => true,
    async run(argv) {
      calls.push(argv.join(" "));
      if (argv.includes("logout")) { loggedIn = false; return { code: 0, out: "secret output must not be returned" }; }
      return { code: 0, out: JSON.stringify({ loggedIn, authenticated: loggedIn, email: "test@example.test", accessToken: "do-not-return" }) };
    },
    codexAccount: async () => ({ account: loggedIn ? { type: "chatgpt", email: "test@example.test", planType: "pro" } : null }),
    commandEnv: () => ({ COMMAND_CODE_API_KEY: "secret-key" }),
    clearCommandToken: () => { calls.push("clear-key"); },
    since: () => "2026-10-30T00:00:00Z", forget: (p) => { calls.push(`forget:${p}`); },
    cancel: async (p) => { calls.push(`cancel:${p}`); },
    start: async (p) => { calls.push(`start:${p}`); return { running: true }; },
    loginStatus: async () => ({ state: "idle" }),
    submitClaudeCode: async () => ({ ok: true }),
    ...overrides,
  };
  return { calls, controller: createAgentAccounts(deps) };
}

test("account details whitelist identity fields and never expose tokens or routing data", () => {
  const result = parseAccount("codex", { account: { type: "chatgpt", email: "test@example.test", planType: "pro", token: "secret" }, workspaceRouting: { chatgptAccountId: "private" } });
  expect(result).toMatchObject({ loggedIn: true, email: "test@example.test", plan: "pro" });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(JSON.stringify(result)).not.toContain("private");
  expect(parseAccount("claude", { loggedIn: false, email: "old@example.test" }).email).toBeNull();
  expect(parseAccount("command-code", { authenticated: true }).email).toBeNull();
  expect(parseAccount("codex", null).loggedIn).toBeNull();
});

test("switch cancels login, signs out, verifies, then starts a replacement login", async () => {
  const { calls, controller } = harness();
  expect(await controller.action("codex", "switch")).toMatchObject({ ok: true, login: { running: true } });
  expect(calls[0]).toBe("cancel:codex");
  expect(calls[1]).toBe("codex logout");
  expect(calls.at(-1)).toBe("start:codex");
  expect(JSON.stringify(await controller.list())).not.toContain("do-not-return");
});

test("failed logout never starts a replacement or clears a stored key", async () => {
  const { calls, controller } = harness({ run: async () => ({ code: 1, out: "private diagnostic" }) });
  const result = await controller.action("command-code", "switch");
  expect(result.ok).toBe(false);
  expect(calls).toEqual(["cancel:command-code"]);
  expect(JSON.stringify(result)).not.toContain("private diagnostic");
});

test("Command Code clears both credential sources and returns browser instructions for replacement", async () => {
  const { controller, calls } = harness();
  expect(await controller.action("command-code", "switch")).toMatchObject({ ok: true, requiresBrowser: true });
  expect(calls).toContain("command-code --no-auto-update logout");
  expect(calls).toContain("clear-key");
  expect(calls).not.toContain("start:command-code");
  expect((await controller.account("command-code")).loggedInSince).toBeNull();
});

test("unknown account or action cannot execute a command", async () => {
  const { controller, calls } = harness();
  expect((await controller.action("codex;sh", "logout")).ok).toBe(false);
  expect((await controller.action("codex", ["login"])).ok).toBe(false);
  expect((await controller.action("codex", "submit_code", "1234")).ok).toBe(false);
  expect(calls).toEqual([]);
});

test("browser account routes require a cookie and same-origin mutations", async () => {
  const { controller, calls } = harness();
  const deps = { cookieName: "xs_auth", origin: "https://example.test", checkBrowserSession: (t: string | null) => t === "browser", accounts: controller };
  const request = (headers: Record<string, string>) => new Request("https://example.test/api/agent-accounts", { method: "POST", headers, body: JSON.stringify({ provider: "codex", action: "logout" }) });
  expect((await handleAgentAccountsRoute(request({ authorization: "Bearer cli" }), deps))?.status).toBe(401);
  expect((await handleAgentAccountsRoute(request({ cookie: "xs_auth=browser", origin: "https://other.test" }), deps))?.status).toBe(403);
  expect(calls).toEqual([]);
  const response = await handleAgentAccountsRoute(request({ cookie: "xs_auth=browser", origin: "https://example.test" }), deps);
  expect(response?.status).toBe(200);
  expect(response?.headers.get("cache-control")).toBe("private, no-store");
});

test("Command Code native signed-out state permits clearing an app key and repeated logout", async () => {
  const { controller, calls } = harness({
    run: async (argv, env) => {
      expect(env ?? {}).toEqual({});
      return argv.includes("logout") ? { code: 1, out: "Already logged out" }
        : { code: 1, out: JSON.stringify({ authenticated: false }) };
    },
    commandEnv: () => ({}),
  });
  expect((await controller.action("command-code", "logout")).ok).toBe(true);
  expect((await controller.action("command-code", "logout")).ok).toBe(true);
  expect(calls.filter(c => c === "clear-key")).toHaveLength(2);
});

test("failed callback submission and failed login start propagate sanitized failures", async () => {
  const { controller } = harness({
    submitClaudeCode: async () => ({ ok: false, error: "secret diagnostic" }),
    start: async () => ({ ok: false, error: "secret diagnostic" }),
  });
  expect((await controller.action("claude", "submit_code", "1234")).ok).toBe(false);
  const result = await controller.action("claude", "login");
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("secret diagnostic");
});
