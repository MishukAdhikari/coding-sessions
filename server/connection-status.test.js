import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function harness() {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { dataset: {}, textContent: "", appendChild(node) { this.textContent = node.textContent; } });
      return nodes.get(id);
    },
    createTextNode: textContent => ({ textContent }),
  };
  const window = {};
  runInNewContext(readFileSync(new URL("../public/connection-status.js", import.meta.url), "utf8"),
    { window, document, AbortController, setTimeout, clearTimeout });
  return { ...window.connectionStatus, nodes };
}

test("authorized apps, configured tokens and missing connections have distinct states", () => {
  const { describe } = harness();
  expect(describe.connect({ connections: [{}] })).toMatchObject({ tone: "positive", label: "Connected" });
  expect(describe.connect({ connections: [] }).label).toBe("Not connected");
  expect(describe.cli({ tokens: [{}] }).label).toBe("Configured");
  expect(describe.cli({ tokens: [] }).label).toBe("Not configured");
});

test("agent totals count confirmed sign-ins and keep unknown checks visible", () => {
  const { describe } = harness();
  const accounts = [{ installed: true, loggedIn: true }, { installed: true, loggedIn: true }, { installed: true, loggedIn: false }];
  expect(describe.agents({ accounts })).toMatchObject({ tone: "positive", label: "2 connected", detail: "" });
  accounts[2].loggedIn = null;
  expect(describe.agents({ accounts })).toMatchObject({ tone: "warning", label: "2 connected" });
  expect(describe.agents({ accounts }).detail).toContain("1 agent");
  expect(describe.agents({ accounts: [{ installed: true, loggedIn: null }] }).label).toBe("Unknown");
  expect(describe.agents({ accounts: [{ installed: false, loggedIn: null }] }).label).toBe("0 connected");
});

test("command and project totals describe registrations rather than live connections", () => {
  const { describe } = harness();
  expect(describe.commands({ commands: [] }).label).toBe("0 commands");
  expect(describe.commands({ commands: [{}] }).label).toBe("1 command");
  expect(describe.projects({ projects: [{}, {}, {}] }).label).toBe("3 projects");
  expect(describe.projects({ projects: [{}] }).label).toBe("1 project");
});

test("server summaries show schedule health and distinguish live sessions from history", () => {
  const { describe } = harness();
  expect(describe.updates({ available: true, enabled: true, result: "success" })).toMatchObject({ tone: "positive", label: "Daily" });
  expect(describe.updates({ available: true, enabled: false }).label).toBe("Paused");
  expect(describe.updates({ available: true, enabled: true, result: "failed" }).tone).toBe("warning");
  expect(describe.updates({ available: true, running: true }).label).toBe("Updating");
  expect(describe.updates({ available: false }).label).toBe("Not set up");
  expect(describe.history({ archived: [{}, {}] }).label).toBe("2 ended");
  expect(describe.sessions({ sessions: [{ status: "running" }, { status: "starting" }, { status: "ended" }] }).label).toBe("2 live");
});

test("GitHub reports sign-in and installation evidence without treating missing data as signed out", () => {
  const { describe } = harness();
  expect(describe.github({ installed: true, authenticated: true, account: "operator" }).detail).toContain("operator");
  expect(describe.github({ installed: true, authenticated: false }).label).toBe("Not connected");
  expect(describe.github({ installed: false, authenticated: false }).tone).toBe("warning");
  expect(() => describe.github({})).toThrow();
});

test("a saved browser profile never claims a verified live login, and failures take priority", () => {
  const { describe } = harness();
  const saved = { state: "success", running: false, queue: { authed: true, authExpired: false, failed: 0 } };
  expect(describe.browser(saved)).toMatchObject({ tone: "neutral", label: "Not verified" });
  expect(describe.browser({ ...saved, queue: { ...saved.queue, authExpired: true } }).detail).toContain("expired");
  expect(describe.browser({ ...saved, queue: { ...saved.queue, failed: 2 } }).tone).toBe("warning");
  expect(describe.browser({ ...saved, running: true }).label).toBe("Sign-in pending");
  expect(describe.browser({ ...saved, state: "error" }).tone).toBe("warning");
});

test("passkey status is account-level and warns about unusable credentials", () => {
  const { describe } = harness();
  expect(describe.passkey({ passkeys: [{ usable: true }] }).detail).toContain("This device has not been verified");
  expect(describe.passkey({ passkeys: [{ usable: false }] }).tone).toBe("warning");
  expect(describe.passkey({ passkeys: [] }).label).toBe("Not set up");
});

test("one failed check leaves other statuses usable and an older response cannot overwrite a refresh", async () => {
  const h = harness();
  // Abort is cooperative; resolve every first-generation request even if the transport ignores it.
  const pending = [];
  const earlier = h.refresh(() => new Promise(resolve => pending.push(resolve)));
  const current = h.refresh(async path => {
    if (path.includes("github")) throw Error("offline");
    if (path.includes("mcp")) return { connections: [{}] };
    if (path.includes("cli-tokens")) return { tokens: [] };
    if (path.includes("passkeys")) return { passkeys: [] };
    return { queue: { authed: false } };
  });
  await current;
  expect(h.nodes.get("connection-github").textContent).toBe("Check failed");
  expect(h.nodes.get("connection-connect").textContent).toBe("Connected");
  pending.forEach(resolve => resolve({ connections: [] }));
  await earlier;
  expect(h.nodes.get("connection-connect").textContent).toBe("Connected");
});
