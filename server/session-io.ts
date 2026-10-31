import { childEnvironment } from "./child-env";
/**
 * Read a Managed Session's screen and type into it, for the MCP connector — the same
 * two things a person does in the web terminal, without one.
 *
 *  - zmx: `zmx history` prints the scrollback as plain text; `zmx send` writes raw
 *    bytes to the session's pty, exactly as a keyboard would.
 *  - GNU screen (legacy): `hardcopy -h` and `stuff`.
 *
 * Only `cs-*` sessions are reachable: an External Session has no holder to type into.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as mux from "./mux";

const SCREEN_NAME_RE = /^cs-[a-z0-9][a-z0-9_-]{0,42}$/;

/** Named keys an agent's TUI understands, as the bytes a terminal sends for them. */
export const KEYS: Readonly<Record<string, string>> = {
  enter: "\r",
  escape: "\x1b",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  backspace: "\x7f",
  space: " ",
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+l": "\x0c",
};

/** A key name, or one printable character typed as itself. Pure, for tests. */
export function keyBytes(key: string): string | null {
  const named = KEYS[key.toLowerCase()];
  if (named) return named;
  return [...key].length === 1 && key >= " " && key !== "\x7f" ? key : null;
}

/**
 * Text as one paste. Multi-line text goes in bracketed paste, so the agent's input
 * box takes the newlines as part of the message instead of submitting at the first —
 * Claude Code and Codex both turn bracketed paste on. Pure, for tests.
 */
export function pasteBytes(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").replace(/\x1b\[20[01]~/g, "");
  return clean.includes("\n") ? `\x1b[200~${clean}\x1b[201~` : clean;
}

/** `m:cs-name` → `cs-name`, or null for anything that isn't a managed session id. */
export function screenFromId(id: string): string | null {
  const name = id.startsWith("m:") ? id.slice(2) : "";
  return SCREEN_NAME_RE.test(name) ? name : null;
}

/** Last `lines` non-trailing-blank lines of a screen dump. Pure, for tests. */
export function tailLines(text: string, lines: number): string {
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
  const rows = plain.split("\n").map((r) => r.replace(/\s+$/, ""));
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  return rows.slice(-Math.max(1, lines)).join("\n");
}

async function run(cmd: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: childEnvironment() });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  } catch (e) {
    return { code: 127, out: "", err: String((e as Error)?.message ?? e) };
  }
}

export type IoResult<T> = { ok: true; value: T } | { ok: false; error: string };

async function holder(id: string): Promise<IoResult<mux.MuxSession>> {
  const screen = screenFromId(id);
  if (!screen) return { ok: false, error: "Only app-managed sessions (ids starting m:cs-) can be read or typed into." };
  const found = await mux.find(screen);
  return found ? { ok: true, value: found } : { ok: false, error: "That session has ended." };
}

/** The bottom of the session's screen, as plain text. */
export async function readScreen(id: string, lines = 60): Promise<IoResult<string>> {
  const h = await holder(id);
  if (!h.ok) return h;
  if (h.value.backend === "zmx") {
    const r = await run([mux.ZMX_BIN ?? "zmx", "history", h.value.name]);
    if (r.code !== 0) return { ok: false, error: r.err.trim() || "Couldn't read the session." };
    return { ok: true, value: tailLines(r.out, lines) };
  }
  const file = join(tmpdir(), `xcs-hardcopy-${randomBytes(6).toString("hex")}`);
  try {
    const r = await run(["screen", "-S", h.value.name, "-X", "hardcopy", "-h", file]);
    if (r.code !== 0) return { ok: false, error: r.err.trim() || "Couldn't read the session." };
    await Bun.sleep(150); // screen writes the file from its own process
    return { ok: true, value: tailLines(readFileSync(file, "utf8"), lines) };
  } catch {
    return { ok: false, error: "Couldn't read the session." };
  } finally {
    rmSync(file, { force: true });
  }
}

async function write(session: mux.MuxSession, bytes: string): Promise<IoResult<true>> {
  if (bytes.includes("\0")) return { ok: false, error: "Text can't contain NUL." };
  const r = session.backend === "zmx"
    ? await run([mux.ZMX_BIN ?? "zmx", "send", session.name, bytes])
    // screen's `stuff` reads backslash escapes; double them so text arrives as typed.
    : await run(["screen", "-S", session.name, "-X", "stuff", bytes.replace(/\\/g, "\\\\")]);
  return r.code === 0 ? { ok: true, value: true } : { ok: false, error: r.err.trim() || "Couldn't type into the session." };
}

/** Type text into the session's input, then press Enter unless `submit` is false. */
export async function sendText(id: string, text: string, submit = true): Promise<IoResult<true>> {
  const h = await holder(id);
  if (!h.ok) return h;
  if (text) {
    const typed = await write(h.value, pasteBytes(text));
    if (!typed.ok) return typed;
  }
  if (!submit) return { ok: true, value: true };
  // Enter on its own write, after the TUI has taken the paste in: sent together, a
  // TUI can read the CR as part of the paste and leave the message unsent.
  await Bun.sleep(text ? 250 : 0);
  return write(h.value, KEYS.enter!);
}

/** Press keys in order (see KEYS), with a short gap so a menu redraws between them. */
export async function sendKeys(id: string, keys: readonly string[]): Promise<IoResult<true>> {
  const bytes = keys.map(keyBytes);
  const bad = keys.find((_, i) => bytes[i] === null);
  if (bad !== undefined) return { ok: false, error: `Unknown key “${bad}”. Use ${Object.keys(KEYS).join(", ")}, or one character.` };
  const h = await holder(id);
  if (!h.ok) return h;
  for (const [i, b] of bytes.entries()) {
    if (i) await Bun.sleep(80);
    const r = await write(h.value, b!);
    if (!r.ok) return r;
  }
  return { ok: true, value: true };
}
