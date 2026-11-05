import { expect, test } from "bun:test";
import { createAgentInstaller, parseAgents } from "./agent-installs";

/** A fake installer process whose output and exit the test controls. */
function fakeProcess() {
  let finish!: (code: number) => void;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const exited = new Promise<number>(resolve => { finish = resolve; });
  return {
    child: { stdout, stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }), exited, kill: () => finish(143) },
    print: (text: string) => controller.enqueue(new TextEncoder().encode(text)),
    exit: (code: number) => { controller.close(); finish(code); },
  };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 5));

test("only known agents can be named, each once", () => {
  expect(parseAgents(["gemini", "kimi", "gemini"])).toEqual({ ok: true, agents: ["gemini", "kimi"] });
  expect(parseAgents([])).toMatchObject({ ok: false });
  expect(parseAgents("gemini")).toMatchObject({ ok: false });
  expect(parseAgents(["gemini", "; rm -rf /"])).toMatchObject({ ok: false, error: expect.stringContaining("Unknown agent") });
});

test("an install runs the installer script with only the agent names, reports its output, and finishes", async () => {
  const fake = fakeProcess();
  const seen: string[][] = [];
  let finished = 0;
  const installer = createAgentInstaller({ script: "/app/deploy/install-provider-clis", spawn: argv => { seen.push(argv); return fake.child; }, onFinished: () => finished++ });
  expect(installer.status()).toBeNull();
  const started = installer.start(["gemini", "kimi"]);
  expect(started).toMatchObject({ ok: true, job: { agents: ["gemini", "kimi"], running: true, result: "running" } });
  expect(seen).toEqual([["bash", "/app/deploy/install-provider-clis", "gemini", "kimi"]]);
  expect(installer.start(["qwen"])).toMatchObject({ ok: false, status: 409 });
  fake.print("added 1 package\n0.66.0\n");
  fake.exit(0);
  await settle();
  expect(installer.status()).toMatchObject({ running: false, result: "success", output: "added 1 package\n0.66.0\n" });
  expect(installer.status()!.finishedAt).not.toBeNull();
  expect(finished).toBe(1);
});

test("a failed install is reported as failed, and a new one can start", async () => {
  const first = fakeProcess();
  const second = fakeProcess();
  const queue = [first, second];
  const installer = createAgentInstaller({ script: "x", spawn: () => queue.shift()!.child });
  installer.start(["kimi"]);
  first.print("Node.js 22.19.0 or newer is required for kimi.\n");
  first.exit(1);
  await settle();
  expect(installer.status()).toMatchObject({ result: "failed", output: expect.stringContaining("22.19.0") });
  expect(installer.start(["gemini"])).toMatchObject({ ok: true });
  second.exit(0);
});

test("unknown names never reach the installer", () => {
  let spawned = false;
  const installer = createAgentInstaller({ script: "x", spawn: () => { spawned = true; return fakeProcess().child; } });
  expect(installer.start(["gemini", "--global"])).toMatchObject({ ok: false, status: 422 });
  expect(spawned).toBe(false);
});
