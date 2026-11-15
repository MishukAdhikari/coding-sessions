/**
 * Tokens a session has used, for its card, and the budget someone set for it.
 *
 * The agents record usage in their own transcripts: Claude Code on every assistant
 * message (`message.usage`), Codex as a running total (`token_count` events). Each
 * transcript is read from the start once, a few MiB per poll, then only the bytes
 * written since the previous poll.
 *
 * "Tokens" here are what was sent fresh and what came back: input (with cache writes)
 * plus output. Cache reads are kept apart: they repeat the same context on every
 * request and would drown the number.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { Database } from "bun:sqlite";

export type UsageFormat = "claude" | "codex";

export interface SessionUsage {
  /** Fresh input plus output. */
  tokens: number;
  input: number;
  output: number;
  /** Input served from the provider's cache. */
  cached: number;
}

interface Counts { input: number; output: number; cached: number }
const ZERO: Counts = { input: 0, output: 0, cached: 0 };
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/** One Claude Code transcript line → the message's id and usage, or null. Pure. */
export function claudeUsage(line: string): { id: string; counts: Counts } | null {
  if (!line.includes('"usage"')) return null;
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  const message = o?.message;
  const usage = message?.usage;
  if (o?.type !== "assistant" || !usage || typeof usage !== "object") return null;
  const id = typeof message.id === "string" && message.id ? message.id : typeof o.uuid === "string" ? o.uuid : null;
  if (!id) return null;
  return {
    id,
    counts: {
      input: num(usage.input_tokens) + num(usage.cache_creation_input_tokens),
      output: num(usage.output_tokens),
      cached: num(usage.cache_read_input_tokens),
    },
  };
}

/** One Codex rollout line → the conversation's running total, or null. Pure. */
export function codexUsage(line: string): Counts | null {
  if (!line.includes('"token_count"')) return null;
  let o: any;
  try { o = JSON.parse(line); } catch { return null; }
  const total = o?.payload?.type === "token_count" ? o.payload.info?.total_token_usage : null;
  if (!total || typeof total !== "object") return null;
  const cached = num(total.cached_input_tokens);
  // Codex counts cached input inside input_tokens.
  return { input: Math.max(0, num(total.input_tokens) - cached), output: num(total.output_tokens), cached };
}

interface Tracked {
  format: UsageFormat;
  offset: number;
  /** The unfinished last line, as bytes: a read can end inside a character. */
  carry: Buffer;
  /** Claude: a message is written once per content block, each time with its usage so far. */
  messages: Map<string, Counts>;
  sum: Counts;
  /** Codex: totals of earlier runs (a resumed conversation starts counting again), and this run's. */
  base: Counts;
  run: Counts;
}

const add = (a: Counts, b: Counts): Counts => ({ input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached });
const sub = (a: Counts, b: Counts): Counts => ({ input: a.input - b.input, output: a.output - b.output, cached: a.cached - b.cached });

const CHUNK = 1024 * 1024;
/** Most bytes read from one transcript in one poll: a long transcript catches up over a few polls. */
const MAX_PER_READ = 8 * CHUNK;
const MAX_LINE = 4 * CHUNK;

export function createUsageReader(limits: { maxPerRead?: number } = {}) {
  const maxPerRead = limits.maxPerRead ?? MAX_PER_READ;
  const tracked = new Map<string, Tracked>();

  function take(state: Tracked, line: string): void {
    if (state.format === "claude") {
      const found = claudeUsage(line);
      if (!found) return;
      const before = state.messages.get(found.id) ?? ZERO;
      state.messages.set(found.id, found.counts);
      state.sum = add(state.sum, sub(found.counts, before));
      return;
    }
    const total = codexUsage(line);
    if (!total) return;
    if (total.input + total.output < state.run.input + state.run.output) state.base = add(state.base, state.run);
    state.run = total;
  }

  /** The usage recorded in `path` so far; null while it is unread, unreadable or still catching up. */
  function read(path: string | null, format: UsageFormat): SessionUsage | null {
    if (!path) return null;
    let size: number;
    try { size = statSync(path).size; } catch { tracked.delete(path); return null; }
    let state = tracked.get(path);
    if (!state || state.format !== format || size < state.offset) {
      state = { format, offset: 0, carry: Buffer.alloc(0), messages: new Map(), sum: ZERO, base: ZERO, run: ZERO };
      tracked.set(path, state);
    }
    if (size > state.offset) {
      let fd: number | undefined;
      try {
        fd = openSync(path, "r");
        const end = Math.min(size, state.offset + maxPerRead);
        const buffer = Buffer.allocUnsafe(CHUNK);
        let pending = state.carry;
        while (state.offset < end) {
          const got = readSync(fd, buffer, 0, Math.min(CHUNK, end - state.offset), state.offset);
          if (got <= 0) break;
          state.offset += got;
          const data = pending.length ? Buffer.concat([pending, buffer.subarray(0, got)]) : buffer.subarray(0, got);
          let newline: number;
          let from = 0;
          while ((newline = data.indexOf(10, from)) !== -1) {
            take(state, data.toString("utf8", from, newline));
            from = newline + 1;
          }
          // A line longer than this holds a pasted file, not a usage record worth the memory.
          pending = data.length - from > MAX_LINE ? Buffer.alloc(0) : Buffer.from(data.subarray(from));
        }
        state.carry = pending;
      } catch {
        return null;
      } finally {
        if (fd !== undefined) try { closeSync(fd); } catch {}
      }
    }
    if (state.offset < size) return null;
    const counts = format === "claude" ? state.sum : add(state.base, state.run);
    return { tokens: counts.input + counts.output, ...counts };
  }

  return {
    read,
    /** Forget transcripts no live session points at. */
    keepOnly(paths: Set<string>): void {
      for (const path of tracked.keys()) if (!paths.has(path)) tracked.delete(path);
    },
  };
}

/* ---------- budgets ---------- */

export const MAX_BUDGET_TOKENS = 1_000_000_000_000;

/** "2M", "500k", "1.5m", "250000" → tokens; null for nothing or zero (no budget); undefined when it is not a number. */
export function parseBudget(value: unknown): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  let tokens: number;
  if (typeof value === "number") tokens = value;
  else if (typeof value === "string") {
    const m = /^\s*(\d+(?:[.,]\d+)?)\s*([kmb])?\s*(?:tokens?)?\s*$/i.exec(value.replace(/(\d)[_,](?=\d{3}\b)/g, "$1"));
    if (!m) return undefined;
    tokens = Number(m[1]!.replace(",", ".")) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1);
  } else return undefined;
  if (!Number.isFinite(tokens) || tokens < 0 || tokens > MAX_BUDGET_TOKENS) return undefined;
  tokens = Math.round(tokens);
  return tokens === 0 ? null : tokens;
}

export type BudgetResult = { ok: true; budget: number | null } | { ok: false; status: 404 | 422; error: string };

/** A budget belongs to one launch and goes with it; a restart carries it over (see index.ts). */
export function createBudgets(database: Database) {
  const launchOf = (screen: string) =>
    (database.query("SELECT launch_id FROM launches WHERE screen = ?").get(screen) as { launch_id: string | null } | null);
  return {
    /** screen → tokens, for every live launch that has a budget. */
    all(): Map<string, number> {
      const rows = database.query(
        "SELECT l.screen AS screen, b.tokens AS tokens FROM session_budgets b JOIN launches l ON l.launch_id = b.launch_id",
      ).all() as Array<{ screen: string; tokens: number }>;
      return new Map(rows.map((row) => [row.screen, row.tokens]));
    },
    get(screen: string): number | null {
      return this.all().get(screen) ?? null;
    },
    set(screen: string, value: unknown, now = Date.now()): BudgetResult {
      const tokens = parseBudget(value);
      if (tokens === undefined) return { ok: false, status: 422, error: "A budget is a number of tokens, such as 2M or 500k. Leave it empty for none." };
      const launch = launchOf(screen);
      if (!launch) return { ok: false, status: 404, error: "No such session." };
      if (!launch.launch_id) return { ok: false, status: 422, error: "This session was started before budgets existed. Restart it to set one." };
      if (tokens === null) database.query("DELETE FROM session_budgets WHERE launch_id = ?").run(launch.launch_id);
      else {
        database.query(
          "INSERT INTO session_budgets (launch_id, tokens, updated_at) VALUES (?, ?, ?) " +
          "ON CONFLICT(launch_id) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at",
        ).run(launch.launch_id, tokens, now);
      }
      return { ok: true, budget: tokens };
    },
  };
}
