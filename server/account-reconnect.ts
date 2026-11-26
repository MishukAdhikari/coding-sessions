/**
 * Reconnect running sessions after an agent's account changes.
 *
 * A running agent keeps the MCP connections it opened under the old account: Claude Code marks
 * its remote MCP servers "account changed, reconnect", and a failed connection is not retried.
 * When the signed-in identity of Claude, Codex or Command Code changes, every session of that
 * agent started before the change is restarted onto the same conversation, which reconnects all
 * of its MCP servers under the new account. An idle session restarts on the next check; a busy
 * or asking one waits until its turn ends, so no work is cut off.
 *
 * Signing in again to the same account changes nothing. The first identity seen after the
 * server starts is only a baseline. Logged out or unknown is ignored, so a switch (sign out,
 * then sign in) counts once, against the account before it.
 */
export type AccountAgent = "claude" | "codex" | "command-code";
export const ACCOUNT_AGENTS: AccountAgent[] = ["claude", "codex", "command-code"];

export interface ReconnectSession {
  id: string;
  provider: string;
  /** When this launch started (ms). Sessions started after the change already use the new account. */
  startedAt: number;
  /** Mid-turn or waiting on a question: restart later. */
  busy: boolean;
}

export interface AccountReconnectDeps {
  /** A stable identity for the signed-in account, or null when signed out or unknown. */
  identity(agent: AccountAgent): Promise<string | null>;
  sessions(): Promise<ReconnectSession[]>;
  restart(id: string): Promise<{ ok: boolean; error?: string }>;
  log(line: string): void;
  now(): number;
}

export function createAccountReconnect(deps: AccountReconnectDeps) {
  const known = new Map<AccountAgent, string>();
  /** Session id → when its agent's account changed. */
  const pending = new Map<string, { agent: AccountAgent; changedAt: number }>();
  let running: Promise<void> | null = null;

  async function observe(agent: AccountAgent, changedAt: number): Promise<void> {
    for (const s of await deps.sessions()) {
      if (s.provider === agent && s.id.startsWith("m:") && s.startedAt < changedAt && !pending.has(s.id)) pending.set(s.id, { agent, changedAt });
    }
  }

  async function check(agents: AccountAgent[]): Promise<void> {
    for (const agent of agents) {
      let current: string | null;
      try { current = await deps.identity(agent); } catch { continue; }
      if (current === null) continue;
      const before = known.get(agent);
      known.set(agent, current);
      if (before === undefined || before === current) continue;
      deps.log(`account-reconnect: ${agent} account changed; reconnecting its running sessions`);
      await observe(agent, deps.now());
    }
    if (!pending.size) return;
    const live = new Map((await deps.sessions()).map(s => [s.id, s]));
    for (const [id, change] of [...pending]) {
      const session = live.get(id);
      // Ended, or already replaced by a launch that started after the change.
      if (!session || session.startedAt >= change.changedAt) { pending.delete(id); continue; }
      if (session.busy) continue;
      pending.delete(id);
      const result = await deps.restart(id).catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : "failed" }));
      deps.log(result.ok ? `account-reconnect: restarted ${id} under the new ${change.agent} account`
        : `account-reconnect: could not restart ${id}: ${result.error ?? "unknown error"}`);
    }
  }

  return {
    /** Check identities (all agents, or the named ones) and restart sessions that are due. One check at a time. */
    tick(agents: AccountAgent[] = ACCOUNT_AGENTS): Promise<void> {
      if (running) return running;
      running = check(agents).finally(() => { running = null; });
      return running;
    },
    /**
     * The account changed in a way the identity cannot show (a new Command Code API key has no
     * email): reconnect that agent's sessions started before now.
     */
    async changed(agent: AccountAgent): Promise<void> {
      deps.log(`account-reconnect: ${agent} credentials replaced; reconnecting its running sessions`);
      await observe(agent, deps.now());
      await this.tick([]);
    },
    /** Sessions still waiting for their turn to end before they restart. */
    pending(): string[] { return [...pending.keys()]; },
  };
}

/** The identity of a parsed account: who, in which organization, by which sign-in method. */
export function accountIdentity(account: { loggedIn: boolean | null; email: string | null; organization?: string | null; authMethod?: string | null; plan?: string | null }): string | null {
  if (account.loggedIn !== true) return null;
  const parts = [account.email, account.organization, account.authMethod].map(v => v ?? "");
  return parts.some(Boolean) ? parts.join("|") : null;
}
