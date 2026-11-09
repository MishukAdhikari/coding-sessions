/**
 * Slash commands an ACP agent advertises (`available_commands_update`, ACP
 * slash-commands): the chat shows them when the operator types "/" and sends the
 * chosen one as ordinary prompt text, `/name args`. The agent may resend the list
 * at any time; the latest one wins. Only what the agent advertised is kept —
 * this app never adds commands of its own.
 */

export interface AcpCommand {
  name: string;
  description: string;
  /** The agent's hint for what to type after the command, when it takes input. */
  hint: string | null;
}

/** Most commands kept from one update (an agent listing every skill can be long). */
export const MAX_COMMANDS = 200;
const MAX_DESCRIPTION = 300;
const MAX_HINT = 120;
/** A name the composer can insert as `/name `: no spaces, no markup. */
const NAME_RE = /^[A-Za-z0-9][\w:.-]{0,63}$/;

const clip = (value: unknown, max: number): string => {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** The usable commands from an `availableCommands` list (or the state file's copy), deduplicated by name. Pure. */
export function sanitizeCommands(list: unknown): AcpCommand[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: AcpCommand[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry.name === "string" ? entry.name.trim().replace(/^\//, "") : "";
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    const input = entry.input && typeof entry.input === "object" ? entry.input as Record<string, unknown> : null;
    // ACP's shape is input.hint; the state file keeps it flattened as hint.
    const hint = clip(input ? input.hint : entry.hint, MAX_HINT);
    out.push({ name, description: clip(entry.description, MAX_DESCRIPTION), hint: hint || null });
    if (out.length >= MAX_COMMANDS) break;
  }
  return out;
}
