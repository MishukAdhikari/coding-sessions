/**
 * Chat (ACP) sessions behind the MCP tools' session I/O. An ACP session has no input
 * box to type into: send_message becomes a prompt through the bridge, or — while the
 * agent waits on a permission request — the answer to it, by option name or id.
 * read_session shows the holder's terminal (the bridge's readable summary) plus any
 * pending request's options, so an MCP driver in the "asking" state can answer it.
 */
import type { Database } from "bun:sqlite";
import { sendBridgeCommand, type BridgeAnswer, type BridgeCommand } from "./client";
import { readEventWindow, readState, type AcpEvent } from "./event-log";
import { findAcpSession } from "./route";

type IoResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface SessionIo {
  readScreen(id: string, lines?: number): Promise<IoResult<string>>;
  sendText(id: string, text: string, submit?: boolean): Promise<IoResult<true>>;
  sendKeys(id: string, keys: readonly string[]): Promise<IoResult<true>>;
}

export interface PendingPermission { requestId: string; title: string; options: Array<{ optionId: string; name: string; kind: string }> }

/** Permission requests in the log that no answer has resolved yet, oldest first. */
export function pendingPermissions(eventsPath: string): PendingPermission[] {
  const open = new Map<string, PendingPermission>();
  let cursor: number | null = null;
  for (let i = 0; i < 1000; i++) {
    const window = readEventWindow(eventsPath, cursor);
    for (const e of window.events as AcpEvent[]) {
      if (e.kind === "permission" && typeof e.requestId === "string") {
        const options = Array.isArray(e.options) ? e.options as PendingPermission["options"] : [];
        const title = String((e.toolCall as { title?: unknown } | null)?.title ?? "a tool call");
        open.set(e.requestId, { requestId: e.requestId, title, options });
      } else if (e.kind === "permission_resolved" && typeof e.requestId === "string") open.delete(e.requestId);
    }
    if (!window.events.length || window.cursor === cursor) break;
    cursor = window.cursor;
  }
  return [...open.values()];
}

const optionList = (p: PendingPermission) => p.options.map((o) => `“${o.name}” (${o.optionId})`).join(", ");

export function acpAwareIo(io: SessionIo, deps: { database: Database; dataDir: string; send?: (socket: string, c: BridgeCommand) => Promise<BridgeAnswer> }): SessionIo {
  const send = deps.send ?? sendBridgeCommand;
  const find = (id: string) => findAcpSession(deps.database, deps.dataDir, id);
  const done = (a: BridgeAnswer): IoResult<true> => (a.ok ? { ok: true, value: true } : { ok: false, error: a.error });

  return {
    async readScreen(id, lines = 60) {
      const found = find(id);
      if (!found.ok) return io.readScreen(id, lines);
      const screen = await io.readScreen(id, lines);
      // Only a waiting bridge has an open request; skip reading the log otherwise.
      const pending = readState(found.paths.state)?.state === "waiting" ? pendingPermissions(found.paths.events)[0] : undefined;
      if (!pending) return screen;
      const note = `\n\n[Chat session] Permission requested: ${pending.title}\nAnswer with send_message using one option: ${optionList(pending)}`;
      return { ok: true, value: `${screen.ok ? screen.value : ""}${note}` };
    },

    async sendText(id, text, submit = true) {
      const found = find(id);
      if (!found.ok) return io.sendText(id, text, submit);
      const state = readState(found.paths.state);
      const pending = state?.state === "waiting" ? pendingPermissions(found.paths.events)[0] : undefined;
      if (pending) {
        const wanted = text.trim().toLowerCase();
        const option = pending.options.find((o) => o.name.toLowerCase() === wanted || o.optionId.toLowerCase() === wanted);
        if (!option) return { ok: false, error: `The agent is waiting for a permission answer for ${pending.title}. Send one option: ${optionList(pending)}.` };
        return done(await send(found.paths.socket, { op: "permission", requestId: pending.requestId, optionId: option.optionId }));
      }
      if (!text.trim()) return { ok: false, error: "Chat sessions take a message, not an empty Enter." };
      return done(await send(found.paths.socket, { op: "prompt", text }));
    },

    async sendKeys(id, keys) {
      if (find(id).ok) return { ok: false, error: "This is a Chat (ACP) session: it takes messages, not key presses. Use send_message; answer a permission request by sending one of its option names." };
      return io.sendKeys(id, keys);
    },
  };
}
