import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HANDOFF_DIR, HANDOFF_MAX_BYTES, HANDOFF_PART_BYTES, HANDOFF_UPLOAD_PATH, HANDOFF_UPLOAD_TTL_MS, HandoffUploads, adoptHandoffTranscript, handleHandoffUpload,
  gunzipPart, handoffUploadCommand, mungeCwd, rewriteTranscriptCwd, stagedTranscriptPath, transcriptSessionId,
} from "./handoff";
import { gzipSync } from "node:zlib";
import { HANDOFF_ORIGIN_FILE, type RequestedHandoffMode } from "./handoff-modes";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "cs-handoff-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

const ID = "0f6c1a2b-1111-4222-8333-944445555666";
const transcript = (cwd: string) => [
  JSON.stringify({ type: "user", sessionId: ID, cwd, message: { role: "user", content: "fix the login bug" } }),
  JSON.stringify({ type: "assistant", sessionId: ID, cwd, message: { role: "assistant", content: "on it" } }),
  "not json but kept",
  "",
].join("\n");

function stage(ws: string, body: string, id = ID) {
  mkdirSync(join(ws, HANDOFF_DIR), { recursive: true });
  writeFileSync(stagedTranscriptPath(ws, id), body);
}

test("rewriteTranscriptCwd points Claude and Codex cwd fields at the server path and keeps other lines", () => {
  const codex = JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/Users/me/app" } });
  const out = rewriteTranscriptCwd(`${transcript("/Users/me/app")}${codex}`, "/srv/ws/cs-app").split("\n");
  expect(JSON.parse(out[0]!).cwd).toBe("/srv/ws/cs-app");
  expect(JSON.parse(out[1]!).message.content).toBe("on it");
  expect(out[2]).toBe("not json but kept");
  expect(JSON.parse(out[3]!).payload.cwd).toBe("/srv/ws/cs-app");
  // A line without cwd is untouched byte for byte.
  expect(rewriteTranscriptCwd('{"a": 1}', "/x")).toBe('{"a": 1}');
});

test("transcriptSessionId reads the conversation id and ignores bad ones", () => {
  expect(transcriptSessionId(transcript("/a"))).toBe(ID);
  expect(transcriptSessionId('{"sessionId":"../etc"}\n')).toBeNull();
  expect(transcriptSessionId("garbage")).toBeNull();
});

test("mungeCwd matches Claude Code's folder naming", () => {
  expect(mungeCwd("/home/u/workspaces/cs-app.v2")).toBe("-home-u-workspaces-cs-app-v2");
});

test("adopt writes the transcript 0600 into the workspace's transcript folder with cwd rewritten, and removes the staging folder", () => {
  const root = temp();
  const ws = join(root, "workspaces", "cs-app");
  const projects = join(root, "projects");
  mkdirSync(ws, { recursive: true });
  stage(ws, transcript("/Users/me/app"));
  const r = adoptHandoffTranscript({ workspace: ws, resumeId: ID, projectsDir: projects });
  expect(r.ok).toBe(true);
  const dest = join(projects, mungeCwd(ws), `${ID}.jsonl`);
  expect(r.ok && r.path).toBe(dest);
  expect(lstatSync(dest).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(dest, "utf8").split("\n")[0]!).cwd).toBe(ws);
  expect(existsSync(join(ws, HANDOFF_DIR))).toBe(false);
});

test("adopt refuses a symlinked transcript, a symlinked staging folder and a symlinked destination", () => {
  const root = temp();
  const ws = join(root, "ws"); mkdirSync(ws);
  const secret = join(root, "secret.txt"); writeFileSync(secret, "top secret");

  mkdirSync(join(ws, HANDOFF_DIR));
  symlinkSync(secret, stagedTranscriptPath(ws, ID));
  let r = adoptHandoffTranscript({ workspace: ws, resumeId: ID, projectsDir: join(root, "p") });
  expect(r).toMatchObject({ ok: false, code: "unsafe_path" });
  expect(existsSync(join(ws, HANDOFF_DIR))).toBe(false);

  const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, `${ID}.jsonl`), transcript("/a"));
  symlinkSync(elsewhere, join(ws, HANDOFF_DIR));
  r = adoptHandoffTranscript({ workspace: ws, resumeId: ID, projectsDir: join(root, "p") });
  expect(r).toMatchObject({ ok: false, code: "unsafe_path" });

  const projects = join(root, "p2");
  mkdirSync(join(projects, mungeCwd(ws)), { recursive: true });
  symlinkSync(secret, join(projects, mungeCwd(ws), `${ID}.jsonl`));
  stage(ws, transcript("/a"));
  r = adoptHandoffTranscript({ workspace: ws, resumeId: ID, projectsDir: projects });
  expect(r).toMatchObject({ ok: false, code: "unsafe_path" });
  expect(readFileSync(secret, "utf8")).toBe("top secret");
});

test("adopt refuses a bad id, a missing, empty or oversized upload", () => {
  const root = temp();
  const ws = join(root, "ws"); mkdirSync(ws);
  expect(adoptHandoffTranscript({ workspace: ws, resumeId: "../x", projectsDir: root })).toMatchObject({ ok: false, code: "invalid_argument" });
  expect(adoptHandoffTranscript({ workspace: ws, resumeId: ID, projectsDir: root })).toMatchObject({ ok: false, code: "not_found" });
  stage(ws, "");
  expect(adoptHandoffTranscript({ workspace: ws, resumeId: ID, projectsDir: root })).toMatchObject({ ok: false, code: "invalid_argument" });
  stage(ws, "x".repeat(100));
  expect(adoptHandoffTranscript({ workspace: ws, resumeId: ID, projectsDir: root, maxBytes: 10 })).toMatchObject({ ok: false, code: "too_large" });
});

test("uploads take parts in order, cap the size, expire, and are single-use", () => {
  let clock = 1000;
  const ws = temp();
  const uploads = new HandoffUploads(() => clock, 10);
  const { token } = uploads.create({ name: "app", workspace: ws, resumeId: null, prompt: null, autoMode: false });
  expect(lstatSync(join(ws, HANDOFF_DIR)).mode & 0o777).toBe(0o700);
  expect(uploads.put(token, 1, new Uint8Array(1))).toMatchObject({ ok: false, status: 409 });
  expect(uploads.put(token, 0, new TextEncoder().encode("12345"))).toMatchObject({ ok: true, parts: 1, bytes: 5 });
  expect(uploads.put(token, 1, new TextEncoder().encode("123456"))).toMatchObject({ ok: false, status: 413, code: "too_large" });
  // Too large discards the upload.
  expect(uploads.put(token, 1, new Uint8Array(1))).toMatchObject({ ok: false, status: 404 });

  const second = uploads.create({ name: "app", workspace: ws, resumeId: null, prompt: null, autoMode: false });
  clock += HANDOFF_UPLOAD_TTL_MS;
  expect(uploads.put(second.token, 0, new Uint8Array(1))).toMatchObject({ ok: false, status: 404 });
  // An expired upload leaves nothing in the checkout.
  expect(existsSync(join(ws, HANDOFF_DIR))).toBe(false);
  expect(uploads.put(token, 0, new Uint8Array(HANDOFF_PART_BYTES + 100_000))).toMatchObject({ ok: false });
});

test("finish reads the id from the transcript when none was given, and the link is spent", () => {
  const ws = temp();
  const uploads = new HandoffUploads();
  const { token } = uploads.create({ name: "app", workspace: ws, resumeId: null, prompt: "go on", autoMode: false });
  uploads.put(token, 0, new TextEncoder().encode(transcript("/a")));
  expect(uploads.finish(token, 2)).toMatchObject({ ok: false, status: 409 });

  const again = uploads.create({ name: "app", workspace: ws, resumeId: null, prompt: "go on", autoMode: false });
  uploads.put(again.token, 0, new TextEncoder().encode(transcript("/a")));
  const done = uploads.finish(again.token, 1);
  expect(done).toMatchObject({ ok: true, ticket: { name: "app", resumeId: ID, prompt: "go on" } });
  expect(readFileSync(stagedTranscriptPath(ws, ID), "utf8")).toBe(transcript("/a"));
  expect(uploads.finish(again.token, 1)).toMatchObject({ ok: false, status: 404 });

  const noId = uploads.create({ name: "app", workspace: ws, resumeId: null, prompt: null, autoMode: false });
  uploads.put(noId.token, 0, new TextEncoder().encode('{"type":"x"}\n'));
  expect(uploads.finish(noId.token, 1)).toMatchObject({ ok: false, code: "invalid_argument" });
});

function routeHarness(ws: string, projects: string) {
  const uploads = new HandoffUploads();
  const launches: Array<[string, string | null, string]> = [];
  const deps = {
    uploads,
    adopt: (_name: string, id: string) => adoptHandoffTranscript({ workspace: ws, resumeId: id, projectsDir: projects }),
    start: async (name: string, o: { resumeId: string; prompt: string | null; mode: RequestedHandoffMode }) => {
      launches.push([name, o.prompt, o.resumeId]);
      return { ok: true as const, job: { state: "launched" as const, mode: "full" as const, requested_mode: o.mode, tokens_before: 10, tokens_after: 10, resume_id: o.resumeId } };
    },
    job: () => null,
    sessionId: (name: string) => `m:cs-${name}`,
  };
  return { uploads, launches, deps };
}

test("the upload route stores parts, adopts on done and launches with the resume id", async () => {
  const root = temp();
  const ws = join(root, "ws"); mkdirSync(ws);
  const projects = join(root, "projects");
  const { uploads, launches, deps } = routeHarness(ws, projects);
  const { token } = uploads.create({ name: "app", workspace: ws, resumeId: ID, prompt: "next step", autoMode: false });
  const base = `https://x${HANDOFF_UPLOAD_PATH}${token}`;
  const body = transcript("/Users/me/app");
  const half = Math.floor(body.length / 2);
  expect((await handleHandoffUpload(new Request(`${base}?part=0`, { method: "PUT", body: body.slice(0, half) }), deps)).status).toBe(200);
  expect((await handleHandoffUpload(new Request(`${base}?part=1`, { method: "PUT", body: body.slice(half) }), deps)).status).toBe(200);
  const res = await handleHandoffUpload(new Request(`${base}?done=2`, { method: "POST" }), deps);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true, session_id: "m:cs-app", resume_id: ID });
  expect(launches).toEqual([["app", "next step", ID]]);
  expect(JSON.parse(readFileSync(join(projects, mungeCwd(ws), `${ID}.jsonl`), "utf8").split("\n")[0]!).cwd).toBe(ws);

  // Spent, malformed and wrong-method requests.
  expect((await handleHandoffUpload(new Request(`${base}?done=2`, { method: "POST" }), deps)).status).toBe(404);
  expect((await handleHandoffUpload(new Request(`https://x${HANDOFF_UPLOAD_PATH}nope?part=0`, { method: "PUT", body: "x" }), deps)).status).toBe(404);
  expect((await handleHandoffUpload(new Request(`${base}?part=-1`, { method: "PUT", body: "x" }), deps)).status).toBe(400);
  expect((await handleHandoffUpload(new Request(base, { method: "GET" }), deps)).status).toBe(405);
});

test("the generated upload command really uploads a transcript from disk to a live server", async () => {
  const root = temp();
  const home = join(root, "home");
  const cwd = "/Users/me/my app";
  const localDir = join(home, ".claude", "projects", mungeCwd(cwd));
  mkdirSync(localDir, { recursive: true });
  // Bigger than one part, so the command splits and sends several.
  const big = transcript(cwd) + JSON.stringify({ type: "user", sessionId: ID, cwd, message: { content: "x".repeat(HANDOFF_PART_BYTES + 5000) } }) + "\n";
  writeFileSync(join(localDir, "older.jsonl"), transcript(cwd));
  await Bun.sleep(20);
  writeFileSync(join(localDir, `${ID}.jsonl`), big);

  const ws = join(root, "ws"); mkdirSync(ws);
  const projects = join(root, "projects");
  for (const id of [ID, null]) {
    const { uploads, launches, deps } = routeHarness(ws, projects);
    const server = Bun.serve({ port: 0, maxRequestBodySize: 1024 * 1024, fetch: (req) => handleHandoffUpload(req, deps) });
    try {
      const { token } = uploads.create({ name: "app", workspace: ws, resumeId: id, prompt: null, autoMode: false });
      const cmd = handoffUploadCommand(`http://127.0.0.1:${server.port}${HANDOFF_UPLOAD_PATH}${token}`, cwd, id);
      const p = Bun.spawn(["sh", "-c", cmd], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(JSON.parse(out)).toMatchObject({ ok: true, session_id: "m:cs-app", resume_id: ID });
      expect(launches).toHaveLength(1);
      const adopted = readFileSync(join(projects, mungeCwd(ws), `${ID}.jsonl`), "utf8");
      expect(adopted.length).toBeGreaterThan(HANDOFF_PART_BYTES);
      expect(adopted).toBe(rewriteTranscriptCwd(big, ws));
    } finally {
      server.stop(true);
    }
  }
});

test("the upload command refuses an oversized transcript before uploading anything", async () => {
  const home = temp();
  const localDir = join(home, ".claude", "projects", mungeCwd("/w"));
  mkdirSync(localDir, { recursive: true });
  const f = join(localDir, `${ID}.jsonl`);
  writeFileSync(f, "");
  truncateSync(f, HANDOFF_MAX_BYTES + 1); // sparse: no real disk use
  // Port 9 is closed: any attempt to upload would fail differently from the size message.
  const p = Bun.spawn(["sh", "-c", handoffUploadCommand("http://127.0.0.1:9/x", "/w", ID)], { env: { ...process.env, HOME: home }, stderr: "pipe" });
  expect(await p.exited).not.toBe(0);
  expect(await new Response(p.stderr).text()).toContain("run /compact");
});

test("the upload command refuses a symlinked transcript and rejects unsafe ids", async () => {
  const root = temp();
  const home = join(root, "home");
  const localDir = join(home, ".claude", "projects", mungeCwd("/w"));
  mkdirSync(localDir, { recursive: true });
  writeFileSync(join(root, "secret"), "s");
  symlinkSync(join(root, "secret"), join(localDir, `${ID}.jsonl`));
  const p = Bun.spawn(["sh", "-c", handoffUploadCommand("http://127.0.0.1:9/x", "/w", ID)], { env: { ...process.env, HOME: home }, stderr: "pipe" });
  expect(await p.exited).not.toBe(0);
  expect(() => handoffUploadCommand("http://x", "/w", "a'b")).toThrow();
});

test("a new link for the same workspace spends the earlier one, and a vanished staging folder is a 404, not a crash", () => {
  const ws = temp();
  const uploads = new HandoffUploads();
  const first = uploads.create({ name: "app", workspace: ws, resumeId: null, prompt: null, autoMode: false });
  const second = uploads.create({ name: "app", workspace: ws, resumeId: null, prompt: null, autoMode: false });
  expect(uploads.put(first.token, 0, new Uint8Array(1))).toMatchObject({ ok: false, status: 404, code: "not_found" });
  expect(uploads.put(second.token, 0, new TextEncoder().encode(transcript("/a")))).toMatchObject({ ok: true });

  rmSync(join(ws, HANDOFF_DIR), { recursive: true, force: true });
  expect(uploads.put(second.token, 1, new Uint8Array(1))).toMatchObject({ ok: false, status: 404 });

  const third = uploads.create({ name: "app", workspace: ws, resumeId: ID, prompt: null, autoMode: false });
  uploads.put(third.token, 0, new Uint8Array(1));
  rmSync(join(ws, HANDOFF_DIR), { recursive: true, force: true });
  expect(uploads.finish(third.token, 1)).toMatchObject({ ok: false, status: 404 });
});

test("gzip parts are inflated, and a zip bomb stops at the part limit", () => {
  const ws = temp();
  const uploads = new HandoffUploads();
  const { token } = uploads.create({ name: "app", workspace: ws, resumeId: ID, prompt: null, autoMode: false });
  const text = transcript("/a");
  expect(uploads.put(token, 0, gzipSync(text), { gzip: true })).toMatchObject({ ok: true, parts: 1, bytes: Buffer.byteLength(text) });
  // 100 MB of zeros gzips to ~100 KB: small on the wire, refused once it inflates past one part.
  const bomb = gzipSync(Buffer.alloc(100 * 1024 * 1024));
  expect(bomb.byteLength).toBeLessThan(HANDOFF_PART_BYTES);
  expect(gunzipPart(bomb)).toBeNull();
  expect(uploads.put(token, 1, bomb, { gzip: true })).toMatchObject({ ok: false, status: 413 });
  // Not gzip at all.
  expect(uploads.put(token, 1, new TextEncoder().encode("plain"), { gzip: true })).toMatchObject({ ok: false, status: 400, code: "bad_gzip" });
  // The upload is still usable: the bad parts were not appended.
  expect(uploads.finish(token, 1)).toMatchObject({ ok: true });
  expect(readFileSync(stagedTranscriptPath(ws, ID), "utf8")).toBe(text);
});

test("the size cap counts decompressed bytes", () => {
  const ws = temp();
  const uploads = new HandoffUploads(Date.now, 1000);
  const { token } = uploads.create({ name: "app", workspace: ws, resumeId: ID, prompt: null, autoMode: false });
  const zeros = gzipSync(Buffer.alloc(2000));
  expect(zeros.byteLength).toBeLessThan(1000);
  expect(uploads.put(token, 0, zeros, { gzip: true })).toMatchObject({ ok: false, status: 413, code: "too_large" });
});

test("a part sent again with the same bytes is a no-op; other bytes conflict; status reports progress", () => {
  const ws = temp();
  const uploads = new HandoffUploads();
  const { token } = uploads.create({ name: "app", workspace: ws, resumeId: ID, prompt: null, autoMode: false });
  const a = new TextEncoder().encode("first ");
  const b = new TextEncoder().encode("second");
  expect(uploads.put(token, 0, a)).toMatchObject({ ok: true, parts: 1 });
  expect(uploads.put(token, 0, a)).toMatchObject({ ok: true, parts: 1, bytes: 6, duplicate: true });
  expect(uploads.put(token, 0, gzipSync(a), { gzip: true })).toMatchObject({ ok: true, duplicate: true });
  expect(uploads.put(token, 0, b)).toMatchObject({ ok: false, status: 409 });
  expect(uploads.status(token)).toEqual({ open: true, parts: 1, bytes: 6 });
  expect(uploads.put(token, 1, b)).toMatchObject({ ok: true, parts: 2 });
  expect(uploads.put(token, 1, b)).toMatchObject({ ok: true, duplicate: true });
  expect(uploads.put(token, 3, b)).toMatchObject({ ok: false, status: 409 });
  expect(uploads.finish(token, 2)).toMatchObject({ ok: true });
  expect(readFileSync(stagedTranscriptPath(ws, ID), "utf8")).toBe("first second");
  // Completion stays single-use; status now names the session.
  expect(uploads.finish(token, 2)).toMatchObject({ ok: false, status: 404 });
  expect(uploads.put(token, 2, b)).toMatchObject({ ok: false, status: 404 });
  expect(uploads.status(token)).toEqual({ open: false, name: "app" });
});

test("?status answers progress, then the handoff's job", async () => {
  const root = temp();
  const ws = join(root, "ws"); mkdirSync(ws);
  const { uploads, deps } = routeHarness(ws, join(root, "projects"));
  const job = { state: "preparing" as const, mode: "lean" as const, requested_mode: "auto" as const, tokens_before: 400_000, resume_id: ID };
  const d = { ...deps, job: () => job };
  const { token } = uploads.create({ name: "app", workspace: ws, resumeId: ID, prompt: null, autoMode: false });
  const base = `https://x${HANDOFF_UPLOAD_PATH}${token}`;
  await handleHandoffUpload(new Request(`${base}?part=0&gz=1`, { method: "PUT", body: gzipSync(transcript("/a")) }), d);
  expect(await (await handleHandoffUpload(new Request(`${base}?status`), d)).json()).toMatchObject({ state: "uploading", parts: 1 });
  expect((await handleHandoffUpload(new Request(`${base}?done=1`, { method: "POST" }), d)).status).toBe(200);
  expect(readFileSync(join(root, "projects", mungeCwd(ws), HANDOFF_ORIGIN_FILE), "utf8").trim()).toBe(ID);
  expect(await (await handleHandoffUpload(new Request(`${base}?status`), d)).json()).toMatchObject({ state: "preparing", mode: "lean", session_id: "m:cs-app" });
});
