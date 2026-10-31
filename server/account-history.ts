import { getMeta, setMeta } from "./db";

export type AccountProvider = "claude" | "codex" | "command-code";
export const isAccountProvider = (value: unknown): value is AccountProvider =>
  value === "claude" || value === "codex" || value === "command-code";

export function createAccountHistory(store: { get(key: string): string | null; set(key: string, value: string): void }, now = () => new Date().toISOString()) {
  const key = (provider: AccountProvider) => `account_login_${provider}`;
  function record(provider: AccountProvider, identity: string | null) {
    store.set(key(provider), identity ? JSON.stringify({ since: now(), identity }) : "null");
  }
  function forget(provider: AccountProvider) { store.set(key(provider), "null"); }
  function since(provider: AccountProvider, identity: string | null): string | null {
    try {
      const value: unknown = JSON.parse(store.get(key(provider)) ?? "null");
      if (!value || typeof value !== "object" || !("since" in value) || typeof value.since !== "string"
        || !("identity" in value) || !Number.isFinite(Date.parse(value.since))) return null;
      if (!identity || typeof value.identity !== "string" || value.identity !== identity) { forget(provider); return null; }
      return value.since;
    } catch { return null; }
  }
  return { record, forget, since };
}

const history = createAccountHistory({ get: getMeta, set: setMeta });
export const recordAccountLogin = history.record;
export const forgetAccountLogin = history.forget;
export const accountLoginSince = history.since;
