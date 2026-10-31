import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

export interface CommunicatorIdentity {
  launch_id: string;
  session_id: string;
  name: string;
  agent: "claude" | "codex" | "command-code";
}
export interface CommunicatorMessage {
  id: string;
  sequence: number;
  sender: CommunicatorIdentity;
  recipient: CommunicatorIdentity;
  text: string;
  reply_to: string | null;
  created_at: number;
  received_at: number | null;
  state: "queued" | "received";
}
export interface MessagePage {
  messages: CommunicatorMessage[];
  next_cursor: number;
  has_more: boolean;
}
interface Dependencies {
  isLive(identity: CommunicatorIdentity): Promise<boolean>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}
interface MessageRow {
  id: string; sequence: number; sender_id: string; recipient_id: string;
  sender_json: string; recipient_json: string; text: string; reply_to: string | null;
  created_at: number; received_at: number | null;
}
export class CommunicatorError extends Error {
  constructor(public readonly code: "unauthorized" | "invalid_request" | "unavailable" | "rate_limited" | "cancelled", message: string) {
    super(message); this.name = "CommunicatorError";
  }
}
const invalid = (message: string): never => { throw new CommunicatorError("invalid_request", message); };
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const RETENTION_MS = 30 * 86400_000;
const PROVIDERS = new Set(["claude", "codex", "command-code"]);
const fields = (value: unknown, allowed: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Expected an object.");
  if (Object.keys(value).some(key => !allowed.includes(key))) return invalid("Unknown argument.");
  return value as Record<string, unknown>;
};
function integer(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) return invalid(`Invalid ${name}.`);
  return value;
}
function message(row: MessageRow): CommunicatorMessage {
  return { id: row.id, sequence: row.sequence, sender: JSON.parse(row.sender_json), recipient: JSON.parse(row.recipient_json),
    text: row.text, reply_to: row.reply_to, created_at: row.created_at, received_at: row.received_at,
    state: row.received_at === null ? "queued" : "received" };
}

/** This capability grants mailbox access only, separate from operator MCP authentication. */
export class Communicator {
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  constructor(private readonly database: Database, private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? Bun.sleep;
  }

  private current(launchId: string): CommunicatorIdentity | null {
    const row = this.database.query("SELECT launch_id, screen, name, provider FROM launches WHERE launch_id=? AND phase != 'failed'")
      .get(launchId) as { launch_id: string; screen: string; name: string; provider: string } | null;
    if (!row || !PROVIDERS.has(row.provider)) return null;
    return { launch_id: row.launch_id, session_id: `m:${row.screen}`, name: row.name, agent: row.provider as CommunicatorIdentity["agent"] };
  }

  /** Called after launch reservation. Re-preparing the same launch invalidates its previous token. */
  prepare(launchId: string): { token: string; identity: CommunicatorIdentity } {
    const identity = this.current(launchId);
    if (!identity) return invalid("Reserve a supported managed launch before preparing its communicator.");
    const token = `cscomm_${randomBytes(32).toString("base64url")}`;
    this.database.query(`INSERT INTO communicator_credentials (launch_id,token_hash,created_at) VALUES (?,?,?)
      ON CONFLICT(launch_id) DO UPDATE SET token_hash=excluded.token_hash,created_at=excluded.created_at,revoked_at=NULL`)
      .run(launchId, hash(token), this.now());
    return { token, identity };
  }

  revoke(launchId: string): void {
    this.database.query("UPDATE communicator_credentials SET revoked_at=? WHERE launch_id=?").run(this.now(), launchId);
  }

  private authenticate(token: string): CommunicatorIdentity {
    const row = typeof token === "string" && /^cscomm_[A-Za-z0-9_-]{43}$/.test(token)
      ? this.database.query("SELECT launch_id FROM communicator_credentials WHERE token_hash=? AND revoked_at IS NULL")
        .get(hash(token)) as { launch_id: string } | null : null;
    const identity = row && this.current(row.launch_id);
    if (!identity) throw new CommunicatorError("unauthorized", "Communicator access is unavailable for this launch.");
    return identity;
  }

  async identity(token: string, requireLive = true): Promise<CommunicatorIdentity> {
    const identity = this.authenticate(token);
    if (requireLive && !await this.deps.isLive(identity)) throw new CommunicatorError("unavailable", "This session is not running.");
    return this.authenticate(token);
  }

  private async participant(launchId: string): Promise<CommunicatorIdentity> {
    const identity = this.current(launchId);
    const credential = this.database.query("SELECT launch_id FROM communicator_credentials WHERE launch_id=? AND revoked_at IS NULL").get(launchId);
    if (!identity || !credential || !await this.deps.isLive(identity) || !this.current(launchId)) {
      throw new CommunicatorError("unavailable", "That peer is not participating or is no longer running.");
    }
    return identity;
  }

  async peers(token: string): Promise<CommunicatorIdentity[]> {
    const self = await this.identity(token);
    const rows = this.database.query("SELECT launch_id FROM communicator_credentials WHERE revoked_at IS NULL AND launch_id != ? ORDER BY launch_id")
      .all(self.launch_id) as Array<{ launch_id: string }>;
    const peers: CommunicatorIdentity[] = [];
    for (const row of rows) {
      try { peers.push(await this.participant(row.launch_id)); }
      catch (error) { if (!(error instanceof CommunicatorError)) throw error; }
    }
    this.authenticate(token);
    return peers;
  }

  async send(token: string, input: unknown): Promise<CommunicatorMessage> {
    const args = fields(input, ["recipient_id", "text", "idempotency_key", "reply_to"]);
    const self = await this.identity(token);
    if (typeof args.text !== "string" || !args.text.trim() || Buffer.byteLength(args.text) > 16 * 1024) return invalid("Message text must contain 1–16384 UTF-8 bytes.");
    if (typeof args.idempotency_key !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotency_key)) return invalid("Use an idempotency key of 1–128 letters, digits, dots, underscores, colons, or dashes.");
    const replyTo = args.reply_to ?? null;
    let recipientId = args.recipient_id;
    if (replyTo !== null) {
      if (typeof replyTo !== "string") return invalid("Invalid reply_to.");
      const original = this.database.query("SELECT sender_id FROM communicator_messages WHERE id=? AND recipient_id=?")
        .get(replyTo, self.launch_id) as { sender_id: string } | null;
      if (!original || (recipientId !== undefined && recipientId !== original.sender_id)) return invalid("Reply to a message received by this session, addressed to its sender.");
      recipientId = original.sender_id;
    }
    if (typeof recipientId !== "string" || !recipientId || recipientId === self.launch_id) return invalid("Choose another participating launch as recipient.");
    const existing = (): CommunicatorMessage | null => {
      const prior = this.database.query("SELECT * FROM communicator_messages WHERE sender_id=? AND idempotency_key=?")
        .get(self.launch_id, args.idempotency_key as string) as MessageRow | null;
      if (!prior) return null;
      if (prior.recipient_id !== recipientId || prior.text !== args.text || prior.reply_to !== replyTo) return invalid("That idempotency key was already used for a different message.");
      return message(prior);
    };
    const prior = existing();
    if (prior) return prior;
    const recipient = await this.participant(recipientId);
    return this.database.transaction(() => {
      this.authenticate(token);
      const concurrent = existing();
      if (concurrent) return concurrent;
      if (!this.current(recipient.launch_id) || !this.database.query("SELECT 1 FROM communicator_credentials WHERE launch_id=? AND revoked_at IS NULL").get(recipient.launch_id)) {
        throw new CommunicatorError("unavailable", "That peer is no longer participating.");
      }
      const count = this.database.query("SELECT COUNT(*) AS n FROM communicator_messages WHERE sender_id=? AND created_at>?")
        .get(self.launch_id, this.now() - 60_000) as { n: number };
      if (count.n >= 60) throw new CommunicatorError("rate_limited", "Message limit reached; wait a minute before sending again.");
      const id = randomUUID();
      this.database.query(`INSERT INTO communicator_messages (id,sender_id,recipient_id,sender_json,recipient_json,idempotency_key,text,reply_to,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(id, self.launch_id, recipient.launch_id, JSON.stringify(self), JSON.stringify(recipient), args.idempotency_key as string, args.text as string, replyTo as string | null, this.now());
      return message(this.database.query("SELECT * FROM communicator_messages WHERE id=?").get(id) as MessageRow);
    })();
  }

  async read(token: string, input: unknown = {}, signal?: AbortSignal): Promise<MessagePage> {
    const args = fields(input, ["direction", "after", "limit", "unread_only"]);
    const self = await this.identity(token);
    if (signal?.aborted) throw new CommunicatorError("cancelled", "Wait cancelled.");
    const direction = args.direction ?? "inbox";
    if (direction !== "inbox" && direction !== "sent") return invalid("direction must be inbox or sent.");
    const after = integer(args.after, 0, 0, Number.MAX_SAFE_INTEGER, "after cursor");
    const limit = integer(args.limit, 50, 1, 100, "limit");
    const unread = args.unread_only ?? (direction === "inbox");
    if (typeof unread !== "boolean") return invalid("unread_only must be boolean.");
    return this.database.transaction(() => {
      this.authenticate(token);
      const rows = this.database.query(`SELECT * FROM communicator_messages WHERE ${direction === "inbox" ? "recipient_id" : "sender_id"}=?
        AND sequence>? ${unread ? "AND received_at IS NULL" : ""} ORDER BY sequence LIMIT ?`).all(self.launch_id, after, limit + 1) as MessageRow[];
      const page = rows.slice(0, limit);
      if (direction === "inbox") for (const row of page) {
        if (row.received_at !== null) continue;
        row.received_at = this.now();
        this.database.query("UPDATE communicator_messages SET received_at=? WHERE id=? AND received_at IS NULL").run(row.received_at, row.id);
      }
      return { messages: page.map(message), next_cursor: page.at(-1)?.sequence ?? after, has_more: rows.length > limit };
    })();
  }

  async wait(token: string, input: unknown = {}, signal?: AbortSignal): Promise<MessagePage & { timed_out: boolean }> {
    const args = fields(input, ["after", "limit", "timeout_seconds"]);
    const seconds = integer(args.timeout_seconds, 25, 1, 25, "timeout_seconds");
    const deadline = this.now() + seconds * 1000;
    for (;;) {
      if (signal?.aborted) throw new CommunicatorError("cancelled", "Wait cancelled.");
      const page = await this.read(token, { after: args.after, limit: args.limit }, signal);
      if (page.messages.length) return { ...page, timed_out: false };
      if (this.now() >= deadline) return { ...page, timed_out: true };
      await this.sleep(Math.min(1000, deadline - this.now()));
    }
  }

  /** Periodic retention cleanup, preserving credentials for every still-live launch. */
  async prune(): Promise<void> {
    const cutoff = this.now() - RETENTION_MS;
    this.database.query("DELETE FROM communicator_messages WHERE created_at<?").run(cutoff);
    const rows = this.database.query("SELECT launch_id,token_hash FROM communicator_credentials WHERE created_at<?").all(cutoff) as Array<{ launch_id: string; token_hash: string }>;
    for (const row of rows) {
      const identity = this.current(row.launch_id);
      if (identity && await this.deps.isLive(identity)) continue;
      this.database.query("DELETE FROM communicator_credentials WHERE launch_id=? AND token_hash=?").run(row.launch_id, row.token_hash);
    }
  }
}
