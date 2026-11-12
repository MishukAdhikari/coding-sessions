/**
 * Handoff: continue a local agent conversation on the server.
 *
 * The local transcript (Claude Code's ~/.claude/projects/<munged cwd>/<id>.jsonl) is
 * staged inside the prepared Workspace at `.cs-handoff/<id>.jsonl` — by `cs handoff`
 * over SSH, or by the MCP `handoff_session` upload — and adopted here: checked (a
 * regular file, not a symlink, within the size limit), its `cwd` fields rewritten to
 * the Workspace path, and written 0600 into the server's transcript folder for that
 * Workspace, so `claude --resume <id>` there opens the whole conversation.
 *
 * Pure filesystem work with every path passed in, so tests run it in a temp dir.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, constants as fsc } from "node:fs";
import { join } from "node:path";

export const HANDOFF_DIR = ".cs-handoff";
export const HANDOFF_MAX_BYTES = 256 * 1024 * 1024;
/** One upload part; under the server's 1 MiB request body limit. */
export const HANDOFF_PART_BYTES = 768 * 1024;
export const HANDOFF_UPLOAD_TTL_MS = 15 * 60_000;
const RESUME_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export const isResumeId = (id: unknown): id is string => typeof id === "string" && RESUME_ID_RE.test(id);

/** Claude Code's transcript folder name for a cwd. */
export const mungeCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

export const stagedTranscriptPath = (workspace: string, id: string) => join(workspace, HANDOFF_DIR, `${id}.jsonl`);

/**
 * Point every line's `cwd` (Claude Code) and `payload.cwd` (Codex rollouts) at `cwd`.
 * Lines that are not JSON objects are kept byte for byte.
 */
export function rewriteTranscriptCwd(text: string, cwd: string): string {
  return text.split("\n").map((line) => {
    if (!line.includes("\"cwd\"")) return line;
    let obj: any;
    try { obj = JSON.parse(line); } catch { return line; }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return line;
    let changed = false;
    if (typeof obj.cwd === "string") { obj.cwd = cwd; changed = true; }
    if (obj.payload && typeof obj.payload === "object" && typeof obj.payload.cwd === "string") { obj.payload.cwd = cwd; changed = true; }
    return changed ? JSON.stringify(obj) : line;
  }).join("\n");
}

/** The conversation id a Claude Code transcript names on its lines (sessionId), if any. */
export function transcriptSessionId(text: string): string | null {
  for (const line of text.split("\n", 50)) {
    try {
      const id = JSON.parse(line)?.sessionId;
      if (isResumeId(id)) return id;
    } catch {}
  }
  return null;
}

export type AdoptResult = { ok: true; path: string; bytes: number } | { ok: false; error: string; code: string };

/**
 * Move a staged transcript into `<projectsDir>/<munged workspace>/<id>.jsonl` with its
 * cwd rewritten. The staging folder is removed either way, so nothing of the
 * conversation is left inside the git checkout.
 */
export function adoptHandoffTranscript(opts: { workspace: string; resumeId: string; projectsDir: string; maxBytes?: number }): AdoptResult {
  const { workspace, resumeId, projectsDir } = opts;
  const max = opts.maxBytes ?? HANDOFF_MAX_BYTES;
  if (!isResumeId(resumeId)) return { ok: false, code: "invalid_argument", error: "Bad transcript id." };
  const stageDir = join(workspace, HANDOFF_DIR);
  const staged = stagedTranscriptPath(workspace, resumeId);
  try {
    let st;
    try { st = lstatSync(stageDir); } catch { return { ok: false, code: "not_found", error: "No transcript was uploaded for this handoff." }; }
    if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, code: "unsafe_path", error: "The handoff folder is not a plain folder; refusing it." };
    try { st = lstatSync(staged); } catch { return { ok: false, code: "not_found", error: `No uploaded transcript ${resumeId}.jsonl.` }; }
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, code: "unsafe_path", error: "The uploaded transcript is not a regular file (symlinks are refused)." };
    if (st.size === 0) return { ok: false, code: "invalid_argument", error: "The uploaded transcript is empty." };
    if (st.size > max) return { ok: false, code: "too_large", error: `The transcript is ${st.size} bytes; the limit is ${max}. Run /compact locally first.` };
    // O_NOFOLLOW: a symlink swapped in after the lstat is refused, not followed.
    const fd = openSync(staged, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    let text: string;
    try { text = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
    const destDir = join(projectsDir, mungeCwd(workspace));
    mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const dest = join(destDir, `${resumeId}.jsonl`);
    try {
      if (lstatSync(dest).isSymbolicLink()) return { ok: false, code: "unsafe_path", error: "The server's transcript path is a symlink; refusing to write through it." };
    } catch {}
    const tmp = `${dest}.${randomBytes(6).toString("hex")}.tmp`;
    const body = rewriteTranscriptCwd(text, workspace);
    writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
    renameSync(tmp, dest);
    return { ok: true, path: dest, bytes: Buffer.byteLength(body) };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/* ---------- one-time chunked upload links (MCP handoff_session) ---------- */

export interface HandoffTicket {
  name: string;          // the raw session name
  workspace: string;
  resumeId: string | null; // null: read it from the uploaded transcript
  prompt: string | null;
  autoMode: boolean;
  expiresAt: number;
}

interface Upload extends HandoffTicket { parts: number; bytes: number; tmp: string; done: boolean }

export type UploadStep =
  | { ok: true; parts: number; bytes: number }
  | { ok: false; status: number; code: string; error: string };

/**
 * One-time upload links. The token is the only credential, so it is long, random,
 * single-use and short-lived; parts must arrive in order and the total is capped.
 * The bytes go straight to a 0600 file inside the Workspace's staging folder and
 * never into a log or a tool result.
 */
export class HandoffUploads {
  private uploads = new Map<string, Upload>();
  constructor(private readonly now: () => number = Date.now, private readonly maxBytes = HANDOFF_MAX_BYTES) {}

  create(ticket: Omit<HandoffTicket, "expiresAt">): { token: string; expiresAt: number } {
    this.expire();
    // A new link for a Workspace replaces any earlier one: its staging folder is wiped
    // below, so the earlier link could only fail. Spend it now with a clear answer.
    for (const [t, u] of this.uploads) if (u.workspace === ticket.workspace) this.uploads.delete(t);
    const token = `cshand_${randomBytes(32).toString("base64url")}`;
    const expiresAt = this.now() + HANDOFF_UPLOAD_TTL_MS;
    const stageDir = join(ticket.workspace, HANDOFF_DIR);
    rmSync(stageDir, { recursive: true, force: true });
    mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    const tmp = join(stageDir, `upload-${randomBytes(6).toString("hex")}.part`);
    writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
    this.uploads.set(token, { ...ticket, expiresAt, parts: 0, bytes: 0, tmp, done: false });
    return { token, expiresAt };
  }

  private live(token: string): Upload | { ok: false; status: number; code: string; error: string } {
    this.expire();
    const u = this.uploads.get(token);
    if (!u || u.done) return { ok: false, status: 404, code: "not_found", error: "This upload link is unknown, used or expired. Call handoff_session again." };
    return u;
  }

  /** Append part `index` (0-based, in order). */
  put(token: string, index: number, chunk: Uint8Array): UploadStep {
    const u = this.live(token);
    if ("ok" in u) return u;
    if (index !== u.parts) return { ok: false, status: 409, code: "conflict", error: `Expected part ${u.parts}, got ${index}.` };
    if (chunk.byteLength > HANDOFF_PART_BYTES + 64 * 1024) return { ok: false, status: 413, code: "too_large", error: "Part too large." };
    if (u.bytes + chunk.byteLength > this.maxBytes) {
      this.discard(token);
      return { ok: false, status: 413, code: "too_large", error: `The transcript is over ${this.maxBytes} bytes. Run /compact locally and try again.` };
    }
    try {
      const st = lstatSync(u.tmp);
      if (st.isSymbolicLink() || !st.isFile()) { this.discard(token); return { ok: false, status: 409, code: "unsafe_path", error: "Upload file replaced; refusing." }; }
      appendFileSync(u.tmp, chunk);
    } catch {
      // The staging folder went away under the link (the Workspace was removed or reset).
      this.discard(token);
      return { ok: false, status: 404, code: "not_found", error: "This upload link is unknown, used or expired. Call handoff_session again." };
    }
    u.parts++; u.bytes += chunk.byteLength;
    return { ok: true, parts: u.parts, bytes: u.bytes };
  }

  /**
   * Close the upload after `parts` parts: move it to `.cs-handoff/<id>.jsonl` and hand
   * back the ticket. The link is spent either way.
   */
  finish(token: string, parts: number): { ok: true; ticket: HandoffTicket & { resumeId: string } } | { ok: false; status: number; code: string; error: string } {
    const u = this.live(token);
    if ("ok" in u) return u;
    u.done = true;
    this.uploads.delete(token);
    if (parts !== u.parts) { rmSync(join(u.workspace, HANDOFF_DIR), { recursive: true, force: true }); return { ok: false, status: 409, code: "conflict", error: `Got ${u.parts} parts, the command said ${parts}. Call handoff_session again.` }; }
    if (!u.bytes) { rmSync(join(u.workspace, HANDOFF_DIR), { recursive: true, force: true }); return { ok: false, status: 400, code: "invalid_argument", error: "Nothing was uploaded." }; }
    let id = u.resumeId;
    try {
      if (!id) {
        const head = readFileSync(u.tmp, "utf8").slice(0, 256 * 1024);
        id = transcriptSessionId(head);
        if (!id) { rmSync(join(u.workspace, HANDOFF_DIR), { recursive: true, force: true }); return { ok: false, status: 400, code: "invalid_argument", error: "Couldn't read the conversation id from the transcript; pass transcript_id." }; }
      }
      renameSync(u.tmp, stagedTranscriptPath(u.workspace, id));
    } catch {
      // The staging folder went away under the link (the Workspace was removed or reset).
      rmSync(join(u.workspace, HANDOFF_DIR), { recursive: true, force: true });
      return { ok: false, status: 404, code: "not_found", error: "The upload is gone from the server (its workspace was reset). Call handoff_session again." };
    }
    const { parts: _p, bytes: _b, tmp: _t, done: _d, ...ticket } = u;
    return { ok: true, ticket: { ...ticket, resumeId: id } };
  }

  private discard(token: string): void {
    const u = this.uploads.get(token);
    this.uploads.delete(token);
    // The whole staging folder goes, so nothing is left for a commit in the checkout.
    if (u) rmSync(join(u.workspace, HANDOFF_DIR), { recursive: true, force: true });
  }

  private expire(): void {
    const now = this.now();
    for (const [token, u] of this.uploads) if (u.expiresAt <= now) this.discard(token);
  }
}

export const HANDOFF_UPLOAD_PATH = "/mcp/handoff/";

export interface HandoffRouteDeps {
  uploads: HandoffUploads;
  adopt(name: string, resumeId: string): { ok: true; bytes: number } | { ok: false; error: string; code: string };
  launch(name: string, prompt: string | null, resumeId: string, opts: { autoMode: boolean }): Promise<{ ok: true } | { ok: false; error: string }>;
  sessionId(name: string): string;
}

/**
 * PUT  /mcp/handoff/<token>?part=<n>   one part of the transcript, in order
 * POST /mcp/handoff/<token>?done=<n>   close after n parts: adopt, launch with resume
 * The token in the path is the only credential (see HandoffUploads).
 */
export async function handleHandoffUpload(req: Request, deps: HandoffRouteDeps): Promise<Response> {
  const url = new URL(req.url);
  const token = url.pathname.slice(HANDOFF_UPLOAD_PATH.length);
  const reply = (status: number, body: Record<string, unknown>) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });
  if (!/^cshand_[A-Za-z0-9_-]{20,}$/.test(token)) return reply(404, { error: "Unknown upload link.", code: "not_found" });
  if (req.method === "PUT") {
    const part = Number(url.searchParams.get("part"));
    if (!Number.isInteger(part) || part < 0) return reply(400, { error: "part must be a whole number.", code: "invalid_argument" });
    const r = deps.uploads.put(token, part, new Uint8Array(await req.arrayBuffer()));
    return r.ok ? reply(200, { ok: true, parts: r.parts, bytes: r.bytes }) : reply(r.status, { error: r.error, code: r.code });
  }
  if (req.method === "POST") {
    const parts = Number(url.searchParams.get("done"));
    if (!Number.isInteger(parts) || parts < 1) return reply(400, { error: "done must be the number of parts sent.", code: "invalid_argument" });
    const f = deps.uploads.finish(token, parts);
    if (!f.ok) return reply(f.status, { error: f.error, code: f.code });
    const { name, resumeId, prompt, autoMode } = f.ticket;
    const adopted = deps.adopt(name, resumeId);
    if (!adopted.ok) return reply(422, { error: adopted.error, code: adopted.code });
    const launched = await deps.launch(name, prompt, resumeId, { autoMode });
    if (!launched.ok) return reply(422, { error: launched.error, code: "launch_failed" });
    return reply(200, {
      ok: true, session_id: deps.sessionId(name), resume_id: resumeId, bytes: adopted.bytes,
      next: "The server session resumes this conversation; the local agent can stop. Follow it with wait_for_session and read_session.",
    });
  }
  return new Response("Method Not Allowed", { status: 405, headers: { allow: "PUT, POST" } });
}

/**
 * The shell command an agent runs on its own machine to upload a transcript in parts.
 * The file goes from disk to the server without passing through the agent's context.
 */
export function handoffUploadCommand(uploadUrl: string, cwd: string, transcriptId: string | null): string {
  const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  // Only [A-Za-z0-9_-] reach the shell from cwd and the id, so no quoting can break.
  const dir = `"$HOME"/.claude/projects/${mungeCwd(cwd)}`;
  if (transcriptId !== null && !isResumeId(transcriptId)) throw new Error("bad transcript id");
  const file = transcriptId
    ? `${dir}/${transcriptId}.jsonl`
    : `${dir}/"$(ls -t ${dir} | grep '\\.jsonl$' | head -1)"`;
  return "(\n" + [
    `f=${file}`,
    `[ -f "$f" ] && [ ! -L "$f" ] || { echo "no transcript at $f" >&2; exit 1; }`,
    // Refuse an oversized transcript before sending a byte, not after minutes of upload.
    `[ "$(wc -c < "$f")" -le ${HANDOFF_MAX_BYTES} ] || { echo "the transcript is over ${HANDOFF_MAX_BYTES} bytes; run /compact locally first" >&2; exit 1; }`,
    `d=$(mktemp -d) && split -b ${HANDOFF_PART_BYTES} "$f" "$d/p" && i=0`,
    `for p in "$d"/p*; do curl -sS --fail -X PUT -H 'content-type: application/octet-stream' --data-binary @"$p" ${q(uploadUrl)}"?part=$i" >/dev/null || { rm -rf "$d"; exit 1; }; i=$((i+1)); done`,
    `rm -rf "$d"; curl -sS --fail -X POST ${q(uploadUrl)}"?done=$i"`,
  ].join("\n") + "\n)";
}

