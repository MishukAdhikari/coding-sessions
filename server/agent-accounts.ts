import { childEnvironment } from "./child-env";
import { readCodexAccount } from "./account-identity";
import { accountLoginSince, forgetAccountLogin, isAccountProvider, type AccountProvider } from "./account-history";
import { codexAuth } from "./codex-auth";
import * as claudeAuth from "./claude-auth";
import { clearCommandCodeToken, commandCodeEnv } from "./command-code";

type Result = { code: number; out: string };
export type AccountInfo = {
  provider: AccountProvider;
  installed: boolean;
  loggedIn: boolean | null;
  email: string | null;
  plan: string | null;
  organization: string | null;
  authMethod: string | null;
  loggedInSince: string | null;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.length <= 200 && !/[\x00-\x1f]/.test(value) ? value : null;
}
function json(value: string): unknown { try { return JSON.parse(value); } catch { return null; } }

export function parseAccount(provider: AccountProvider, value: unknown): Omit<AccountInfo, "installed" | "loggedInSince"> {
  const data = object(value);
  const account = provider === "codex" ? object(data.account) : data;
  const loggedIn = provider === "codex"
    ? data.account === null ? false : typeof account.type === "string" ? true : null
    : typeof data[provider === "claude" ? "loggedIn" : "authenticated"] === "boolean"
      ? data[provider === "claude" ? "loggedIn" : "authenticated"] === true : null;
  return {
    provider, loggedIn,
    email: loggedIn ? text(account.email) : null,
    plan: loggedIn ? text(account.planType ?? account.subscriptionType) : null,
    organization: loggedIn ? text(account.workspaceName ?? account.orgName) : null,
    authMethod: loggedIn ? text(account.type ?? account.authMethod) : null,
  };
}

async function run(argv: string[], env: Record<string, string> = {}): Promise<Result> {
  try {
    const child = Bun.spawn(argv, { env: childEnvironment(env), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => child.kill(9), 15_000);
    try { return { out: await new Response(child.stdout).text(), code: await child.exited }; }
    finally { clearTimeout(timer); }
  } catch { return { code: 127, out: "" }; }
}

export interface AccountDependencies {
  which(provider: AccountProvider): boolean;
  run(argv: string[], env?: Record<string, string>): Promise<Result>;
  codexAccount(): Promise<unknown>;
  commandEnv(): Record<string, string>;
  clearCommandToken(): void;
  since(provider: AccountProvider, identity: string | null): string | null;
  forget(provider: AccountProvider): void;
  cancel(provider: AccountProvider): Promise<unknown>;
  start(provider: AccountProvider): Promise<unknown>;
  loginStatus(provider: AccountProvider): Promise<unknown>;
  submitClaudeCode(code: string): Promise<unknown>;
}

const defaults: AccountDependencies = {
  which: (provider) => !!Bun.which(provider), run, codexAccount: readCodexAccount,
  commandEnv: commandCodeEnv,
  clearCommandToken: () => { clearCommandCodeToken(); },
  since: accountLoginSince, forget: forgetAccountLogin,
  cancel: async (p) => p === "codex" ? codexAuth.cancel() : p === "claude" ? claudeAuth.cancelAuth() : { ok: true },
  start: async (p) => p === "codex" ? codexAuth.start() : claudeAuth.startAuth(),
  loginStatus: async (p) => {
    if (p === "codex") return codexAuth.status();
    const s = await claudeAuth.authStatus();
    // Terminal tails can contain credentials; MCP receives only the login fields.
    return { running: s.running, url: s.url, stage: s.stage, authorized: s.authorized, error: s.error ? "Claude sign-in failed. Retry sign-in." : null };
  },
  submitClaudeCode: claudeAuth.submitCode,
};

export function createAgentAccounts(deps: AccountDependencies = defaults) {
  const busy = new Set<AccountProvider>();
  async function account(provider: AccountProvider): Promise<AccountInfo> {
    if (!deps.which(provider)) return { ...parseAccount(provider, null), installed: false, loggedInSince: null };
    let data: unknown = null;
    try {
      data = provider === "codex" ? await deps.codexAccount()
        : json((await deps.run(provider === "claude" ? ["claude", "auth", "status", "--json"]
          : ["command-code", "--no-auto-update", "status", "--json"], provider === "command-code" ? deps.commandEnv() : {})).out);
    } catch {}
    const parsed = parseAccount(provider, data);
    if (parsed.loggedIn === false) deps.forget(provider);
    return { ...parsed, installed: true, loggedInSince: parsed.loggedIn ? deps.since(provider, parsed.email) : null };
  }
  async function logout(provider: AccountProvider) {
    await deps.cancel(provider);
    if (deps.which(provider)) {
      const result = await deps.run(provider === "claude" ? ["claude", "auth", "logout"]
        : provider === "codex" ? ["codex", "logout"] : ["command-code", "--no-auto-update", "logout"]);
      if (result.code !== 0) {
        const nativeSignedOut = provider === "command-code" && parseAccount(provider,
          json((await deps.run(["command-code", "--no-auto-update", "status", "--json"])).out)).loggedIn === false;
        if (!nativeSignedOut) return { ok: false, error: "The CLI could not sign out. The app’s saved key was retained and no replacement login was started." };
      }
    }
    if (provider === "command-code") deps.clearCommandToken();
    deps.forget(provider);
    const current = await account(provider);
    if (current.loggedIn !== false && current.installed) return { ok: false, error: "Sign-out could not be verified. Check for credentials supplied by the service environment." };
    return { ok: true, account: current };
  }
  return {
    account,
    async list() { return { accounts: await Promise.all([account("codex"), account("claude"), account("command-code")]) }; },
    async action(providerValue: unknown, action: unknown, code?: unknown): Promise<Record<string, unknown>> {
      if (!isAccountProvider(providerValue)) return { ok: false, error: "Choose Codex, Claude, or Command Code." };
      const provider = providerValue;
      if (action === "status") return { ok: true, account: await account(provider), login: provider === "command-code" ? null : await deps.loginStatus(provider) };
      if (action !== "login" && action !== "switch" && action !== "logout" && action !== "cancel" && action !== "submit_code") return { ok: false, error: "Unknown account action." };
      if (busy.has(provider)) return { ok: false, error: "An account change is already in progress." };
      busy.add(provider);
      try {
        if (action === "cancel") return { ok: true, login: await deps.cancel(provider) };
        if (action === "submit_code") {
          if (provider !== "claude" || typeof code !== "string") return { ok: false, error: "Only Claude sign-in accepts a callback code." };
          const login = object(await deps.submitClaudeCode(code));
          return login.ok === true ? { ok: true, login: { ok: true } }
            : { ok: false, error: "Claude could not accept the callback code. Check the login attempt and retry." };
        }
        if (action === "logout" || action === "switch") {
          const result = await logout(provider);
          if (!result.ok || action === "logout") return result;
        }
        if (provider === "command-code") return { ok: true, requiresBrowser: true, path: "/?settings=agent-auth&agent=command-code", message: "Enter the replacement API key in Agent authentication. API keys are not accepted through MCP." };
        const login = object(await deps.start(provider));
        if (login.ok === false || login.state === "failed") return { ok: false, error: "Sign-in could not start. Check the CLI and retry." };
        return { ok: true, login };
      } catch { return { ok: false, error: "The account operation failed. Check the CLI on the server and retry." }; }
      finally { busy.delete(provider); }
    },
  };
}

export const agentAccounts = createAgentAccounts();
