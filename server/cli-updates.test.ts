import { expect, test } from "bun:test";
import { createCliUpdates } from "./cli-updates";
import { handleCliUpdatesRoute } from "./cli-updates-route";

function harness(options: { installed?: boolean; running?: boolean; failed?: boolean; commandFailure?: boolean } = {}) {
  const calls: string[][] = [];
  const controller = createCliUpdates(async (argv) => {
    calls.push(argv);
    if (argv[0] === "sudo") return { code: options.commandFailure ? 1 : 0, out: "" };
    if (argv[0] !== "systemctl") return { code: 0, out: "cli 1.2.3\n" };
    if (options.installed === false) return { code: 0, out: "LoadState=not-found\n" };
    if (argv[2]?.endsWith(".timer")) return { code: 0, out: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nNextElapseUSecRealtime=Sat 2026-10-31 00:00:00 UTC\n" };
    return { code: 0, out: `LoadState=loaded\nActiveState=${options.running ? "activating" : "inactive"}\nResult=${options.failed ? "exit-code" : "success"}\nExecMainStartTimestamp=Fri 2026-10-30 00:00:00 UTC\nExecMainExitTimestamp=Fri 2026-10-30 00:01:00 UTC\n` };
  }, async () => null);
  const route = (method: string, body?: unknown, headers: Record<string, string> = { cookie: "xs_auth=valid", origin: "https://example.test" }) => handleCliUpdatesRoute(
    new Request("https://example.test/api/cli-updates", { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { cookieName: "xs_auth", origin: "https://example.test", checkBrowserSession: (token) => token === "valid", controller },
  );
  return { calls, controller, route };
}

test("status reports schedule, versions and last outcome, including a running or failed update", async () => {
  const { controller } = harness();
  expect(await controller.status()).toMatchObject({
    available: true, enabled: true, running: false, result: "success",
    nextRun: "2026-10-31T00:00:00.000Z", lastFinished: "2026-10-30T00:01:00.000Z",
    versions: { codex: "1.2.3", claude: "1.2.3", "command-code": "1.2.3" },
  });
  expect(await harness({ running: true }).controller.status()).toMatchObject({ running: true, result: "running" });
  expect(await harness({ failed: true }).controller.status()).toMatchObject({ result: "failed" });
  expect(await harness({ installed: false }).controller.status()).toMatchObject({ available: false });
});

test("anonymous, bearer-only and cross-origin callers cannot trigger updates", async () => {
  const { calls, route } = harness();
  expect((await route("GET", undefined, {}))?.status).toBe(401);
  expect((await route("POST", { action: "run" }, { authorization: "Bearer cli-token" }))?.status).toBe(401);
  expect((await route("POST", { action: "run" }, { cookie: "xs_auth=valid", origin: "https://other.test" }))?.status).toBe(403);
  expect((await route("POST", { action: "run" }, { cookie: "xs_auth=valid" }))?.status).toBe(403);
  expect(calls).toEqual([]);
});

test("last result survives systemd unloading the service after a pause or reboot", async () => {
  const controller = createCliUpdates(async (argv) => ({ code: 0, out: argv[0] === "systemctl"
    ? "LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n" : "1.2.3" }),
  async () => ({ started: "2026-10-30T00:00:00Z", finished: "2026-10-30T00:01:00Z", result: "success" }));
  expect(await controller.status()).toMatchObject({ enabled: false, result: "success", lastStarted: "2026-10-30T00:00:00.000Z" });
});

test("only fixed actions can reach systemctl, and command failure reaches the UI", async () => {
  const { calls, route } = harness();
  for (const body of [null, [], {}, { action: "run; touch /tmp/unsafe" }, { action: ["run"] }]) {
    expect((await route("POST", body))?.status).toBe(422);
  }
  expect(calls).toEqual([]);
  for (const action of ["run", "enable", "disable"]) {
    const response = await route("POST", { action });
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(calls).toEqual([
    ["sudo", "-n", "/usr/bin/systemctl", "start", "--no-block", "update-coding-clis.service"],
    ["sudo", "-n", "/usr/bin/systemctl", "enable", "--now", "update-coding-clis.timer"],
    ["sudo", "-n", "/usr/bin/systemctl", "disable", "--now", "update-coding-clis.timer"],
  ]);
  expect((await harness({ commandFailure: true }).route("POST", { action: "run" }))?.status).toBe(503);
});

test("administrator-managed instance updates report their units and never invoke sudo", async () => {
  const calls: string[][] = [];
  const controller = createCliUpdates(async (argv) => {
    calls.push(argv);
    return { code: 0, out: "LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\n" };
  }, async () => null, { timer: "xcloud-sessions-update@demo.timer", service: "xcloud-sessions-update@demo.service", controllable: false });
  expect(await controller.status()).toMatchObject({ available: true, controllable: false });
  expect(calls.some(argv => argv.includes("xcloud-sessions-update@demo.timer"))).toBe(true);
  expect(await controller.control("run")).toMatchObject({ ok: false });
  expect(calls.some(argv => argv[0] === "sudo")).toBe(false);
});
