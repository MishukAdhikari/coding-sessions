import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createDocument, loadBody, text } from "./chat-test-dom.js";

/* public/secret-request.js against the page's real markup (#sheet-secret-request and the
 * Requests section of Settings › Secrets), with a fake api that fails the way app.js's does. */

const source = readFileSync(new URL("../public/secret-request.js", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const MIN = 60_000;
const ID = "0f8c2b1e-3d4a-4b5c-8d6e-7f8091a2b3c4";

const view = (over = {}) => ({
  id: ID, kind: "secret", name: "OPENAI_API_KEY",
  reason: "Run the billing tests against the sandbox.\nOnly the test key is needed.",
  state: "pending", created_at: Date.now(), expires_at: Date.now() + 9.5 * MIN,
  requested_by: "session", session: { name: "billing-fix", agent: "claude", id: "m:cs-billing-fix" },
  url: null, host: null, auth: null,
  existing: { set: false, source: null, updated_at: null }, connector: null, detail: null,
  ...over,
});

/** What app.js's api() throws on a non-2xx answer. */
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });

function harness({ lookup = () => view(), answers = {}, grant = "grant-1" } = {}) {
  const document = loadBody(createDocument(), indexHtml);
  const calls = [];
  const sheets = [];
  const toasts = [];
  const counts = { closeSheet: 0, winClose: 0, grants: 0, resolved: 0 };
  const storage = new Map([["cs.secretRequest", "csreq_link"]]);
  const win = {
    close: () => { counts.winClose++; },
    sessionStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    location: { href: "https://cs.example/" },
  };
  const api = async (path, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ path, method: opts.method || "GET", body });
    const key = path.startsWith("/api/secret-requests/") ? path.slice("/api/secret-requests/".length) : path;
    if (key === "lookup") return { request: lookup(body) };
    const answer = answers[key];
    if (typeof answer === "function") return answer(body);
    return answer ?? { ok: true };
  };
  const context = { document };
  context.window = context;
  runInNewContext(source, context);
  const $ = (id) => document.getElementById(id);
  const ui = context.createSecretRequestUI({
    $, api,
    openSheet: (id) => sheets.push(id),
    closeSheet: () => { counts.closeSheet++; },
    showToast: (m) => toasts.push(m),
    agoStr: () => "3h ago",
    getGrant: async () => { counts.grants++; return grant; },
    onResolved: () => { counts.resolved++; },
    doc: document, win,
  });
  const sheet = $("sheet-secret-request");
  const button = (label) => sheet.querySelectorAll("button").find((b) => text(b) === label) ?? null;
  return { ui, $, sheet, calls, sheets, toasts, counts, storage, win, button, document };
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test("a request opened by its link shows who asks, the name and the reason, all as text", async () => {
  const reason = 'Needs it for <img src=x onerror=alert(1)> the "staging" run.\nSecond line.';
  const h = harness({ lookup: () => view({ reason }) });
  await h.ui.openByToken("csreq_link");
  await flush();
  expect(h.calls[0]).toEqual({ path: "/api/secret-requests/lookup", method: "POST", body: { token: "csreq_link" } });
  expect(h.sheets).toEqual(["sheet-secret-request"]);
  expect(text(h.$("secret-request-heading"))).toBe("A session is asking for a secret");
  const all = text(h.sheet);
  expect(all).toContain("billing-fix");
  expect(all).toContain("OPENAI_API_KEY");
  expect(all).toContain("Their reason");
  expect(all).toContain("Every session on this server can read this value, including ones already running.");
  expect(all).toMatch(/Link expires in 10 min/);
  // The reason stays literal text, newlines included: no element was made from it.
  expect(h.sheet.querySelectorAll("img")).toHaveLength(0);
  const quote = h.sheet.querySelector(".sr-reason-text");
  expect(quote.textContent).toBe(reason);
});

test("a request made through the operator connection says so, with the session as secondary text", async () => {
  const h = harness({ lookup: () => view({ requested_by: "operator" }) });
  await h.ui.openByToken("csreq_link");
  await flush();
  expect(text(h.$("secret-request-heading"))).toBe("Requested through the operator connection (MCP)");
  expect(text(h.sheet.querySelector(".sr-who"))).toContain("for billing-fix");
});

test("the field starts empty and unfillable; Save sends the value, clears it and says the tab can close", async () => {
  const h = harness({ answers: { fulfil: { ok: true, name: "OPENAI_API_KEY", state: "fulfilled" } } });
  await h.ui.openByToken("csreq_link");
  await flush();
  const input = h.sheet.querySelector("input");
  expect(input.getAttribute("type")).toBe("password");
  expect(input.getAttribute("autocomplete")).toBe("off");
  expect(input.getAttribute("aria-label")).toBeTruthy();
  expect(input.hasAttribute("data-1p-ignore")).toBe(true);
  expect(input.getAttribute("data-lpignore")).toBe("true");
  expect(input.value).toBe("");
  expect(h.sheet.querySelector("form").getAttribute("autocomplete")).toBe("off");
  expect(text(h.button("Save"))).toBe("Save");
  const firstName = input.getAttribute("name");

  input.value = "sk-test-123";
  h.sheet.querySelector("form").dispatch("submit");
  await flush();
  expect(h.calls.at(-1)).toEqual({ path: "/api/secret-requests/fulfil", method: "POST", body: { token: "csreq_link", value: "sk-test-123" } });
  expect(input.value).toBe("");
  expect(text(h.sheet)).toContain("Saved. You can close this tab.");
  expect(h.sheet.querySelector("input")).toBeNull();
  expect(h.counts.winClose).toBe(1);
  expect(h.storage.has("cs.secretRequest")).toBe(false);
  expect(h.counts.resolved).toBe(1);
  h.button("Done").click();
  expect(h.counts.closeSheet).toBe(1);

  // A fresh field each time: never the same name for a password manager to remember.
  await h.ui.openByToken("csreq_link");
  await flush();
  expect(h.sheet.querySelector("input").getAttribute("name")).not.toBe(firstName);
});

test("a name that already has a value offers Replace…, which asks for the step-up and sends replace with the grant", async () => {
  const h = harness({ lookup: () => view({ existing: { set: true, source: "Bitwarden", updated_at: Date.now() - 3 * 3600_000 } }) });
  await h.ui.openByToken("csreq_link");
  await flush();
  expect(text(h.sheet)).toContain("OPENAI_API_KEY already has a value from Bitwarden, updated 3h ago. Saving replaces it for every session.");
  expect(h.button("Save")).toBeNull();
  expect(h.button("Replace…")).not.toBeNull();
  h.sheet.querySelector("input").value = "sk-new";
  h.sheet.querySelector("form").dispatch("submit");
  await flush();
  expect(h.counts.grants).toBe(1);
  expect(h.calls.at(-1).body).toEqual({ token: "csreq_link", value: "sk-new", replace: true, grant: "grant-1" });
  expect(text(h.sheet)).toContain("Saved. You can close this tab.");
});

test("a cancelled step-up sends nothing and keeps the form", async () => {
  const h = harness({ grant: null, lookup: () => view({ existing: { set: true, source: "this server", updated_at: Date.now() } }) });
  await h.ui.openByToken("csreq_link");
  await flush();
  h.sheet.querySelector("input").value = "sk-new";
  h.sheet.querySelector("form").dispatch("submit");
  await flush();
  expect(h.calls.map((c) => c.path)).toEqual(["/api/secret-requests/lookup"]);
  expect(h.sheet.querySelector("input").value).toBe("sk-new");
});

test("an expired or used link shows one plain message and no form", async () => {
  const h = harness({ lookup: () => { throw httpError(410, "gone", "This request has expired or was already answered."); } });
  await h.ui.openByToken("csreq_link");
  await flush();
  expect(h.sheets).toEqual(["sheet-secret-request"]);
  expect(text(h.sheet)).toContain("This link has expired or was already used. Ask the agent for a new one.");
  expect(h.sheet.querySelector("input")).toBeNull();
  expect(h.sheet.querySelector("form")).toBeNull();
  expect(h.storage.has("cs.secretRequest")).toBe(false);
});

test("other errors show inline under the field and keep the form", async () => {
  const h = harness({ answers: { fulfil: () => { throw httpError(422, "invalid", "The value is too long."); } } });
  await h.ui.openByToken("csreq_link");
  await flush();
  h.sheet.querySelector("input").value = "x";
  h.sheet.querySelector("form").dispatch("submit");
  await flush();
  const alert = h.sheet.querySelector('[role="alert"]');
  expect(alert.hidden).toBe(false);
  expect(text(alert)).toBe("The value is too long.");
  expect(h.sheet.querySelector("input")).not.toBeNull();
  expect(h.storage.has("cs.secretRequest")).toBe(true);
});

test("Decline posts decline and says nothing was saved", async () => {
  const h = harness({ answers: { decline: { ok: true, state: "declined" } } });
  await h.ui.openByToken("csreq_link");
  await flush();
  h.button("Decline").click();
  await flush();
  expect(h.calls.at(-1)).toEqual({ path: "/api/secret-requests/decline", method: "POST", body: { token: "csreq_link" } });
  expect(text(h.sheet)).toContain("Declined. Nothing was saved.");
  expect(h.sheet.querySelector("input")).toBeNull();
  expect(h.counts.winClose).toBe(0);
});

test("a bearer connector names the host, always steps up, and keeps the form when the check fails", async () => {
  const connector = view({ kind: "connector", name: "linear", url: "https://mcp.linear.app/sse", host: "mcp.linear.app", auth: "bearer", existing: null });
  let answer = { ok: false, state: "pending", connector_state: "auth_failed", detail: "The server answered 401: the token was refused." };
  const h = harness({ lookup: () => connector, answers: { connector: () => answer } });
  await h.ui.openByToken("csreq_link");
  await flush();
  expect(text(h.$("secret-request-heading"))).toBe("A session is asking to connect a server");
  expect(text(h.sheet)).toContain("Your token will be sent to mcp.linear.app.");
  expect(text(h.sheet)).toContain("agents use this server’s tools through it but never see the token");
  h.sheet.querySelector("input").value = "lin_api_1";
  h.sheet.querySelector("form").dispatch("submit");
  await flush();
  expect(h.calls.at(-1).body).toEqual({ token: "csreq_link", auth: "bearer", value: "lin_api_1", grant: "grant-1" });
  expect(text(h.sheet.querySelector('[role="alert"]'))).toBe("The server answered 401: the token was refused.");
  expect(h.button("Try again")).not.toBeNull();

  answer = { ok: true, state: "fulfilled", connector: { name: "linear", host: "mcp.linear.app", tools: 12 } };
  h.sheet.querySelector("form").dispatch("submit");
  await flush();
  expect(h.counts.grants).toBe(2);
  expect(text(h.sheet)).toContain("Connected. You can close this tab.");
});

test("an OAuth connector signs in at the host and marks the callback page to say the tab can close", async () => {
  const connector = view({ kind: "connector", name: "linear", url: "https://mcp.linear.app/sse", host: "mcp.linear.app", auth: "oauth", existing: null });
  const h = harness({
    lookup: () => connector,
    answers: {
      connector: { ok: true, state: "pending", connector_id: "11111111-2222-4333-8444-555555555555", next: "oauth" },
      "/api/connectors/11111111-2222-4333-8444-555555555555/oauth/start": { authorization_url: "https://linear.app/oauth/authorize?x=1" },
    },
  });
  await h.ui.openByToken("csreq_link");
  await flush();
  expect(h.sheet.querySelector("form").hidden).toBe(true);
  h.button("Sign in to mcp.linear.app").click();
  await flush();
  expect(h.storage.get("cs.connectorRequestDone")).toBe("1");
  expect(h.calls.map((c) => c.path).slice(1)).toEqual(["/api/secret-requests/connector", "/api/connectors/11111111-2222-4333-8444-555555555555/oauth/start"]);
  expect(h.calls[1].body).toEqual({ token: "csreq_link", auth: "oauth" });
  expect(h.win.location.href).toBe("https://linear.app/oauth/authorize?x=1");
});

test("a connector name that points elsewhere offers no save", async () => {
  const h = harness({ lookup: () => view({ kind: "connector", name: "linear", url: "https://mcp.linear.app/sse", host: "mcp.linear.app", auth: "bearer", existing: null,
    connector: { id: "c1", host: "evil.example", state: "connected", auth_mode: "bearer", credential_set: true, url_matches: false } }) });
  await h.ui.openByToken("csreq_link");
  await flush();
  expect(text(h.sheet)).toContain("A connector with this name points elsewhere; change it in Settings › Connectors.");
  expect(h.sheet.querySelector("input")).toBeNull();
  expect(h.button("Decline")).not.toBeNull();
});

test("Settings › Secrets lists pending requests; Open opens the request by id", async () => {
  const h = harness();
  const container = h.$("secret-requests");
  h.ui.renderSettingsList(container, []);
  expect(container.hidden).toBe(true);
  h.ui.renderSettingsList(container, [view()]);
  expect(container.hidden).toBe(false);
  const all = text(container);
  expect(all).toContain("Requests");
  expect(all).toContain("OPENAI_API_KEY");
  expect(all).toContain("billing-fix · Run the billing tests against the sandbox.");
  expect(all).not.toContain("Only the test key is needed.");
  expect(all).toContain("expires in 10 min");
  container.querySelectorAll("button").find((b) => text(b) === "Open").click();
  await flush();
  expect(h.calls[0]).toEqual({ path: "/api/secret-requests/lookup", method: "POST", body: { id: ID } });
  expect(h.sheets).toEqual(["sheet-secret-request"]);
  // Opened from Settings, not from a link: nothing to say about closing a tab, and no window.close.
  h.sheet.querySelector("input").value = "sk";
  h.sheet.querySelector("form").dispatch("submit");
  await flush();
  expect(text(h.sheet)).toContain("Saved.");
  expect(text(h.sheet)).not.toContain("close this tab");
  expect(h.counts.winClose).toBe(0);
});

test("Decline from the Settings list removes the row", async () => {
  const h = harness();
  const container = h.$("secret-requests");
  h.ui.renderSettingsList(container, [view()]);
  container.querySelectorAll("button").find((b) => text(b) === "Decline").click();
  await flush();
  expect(h.calls.at(-1)).toEqual({ path: "/api/secret-requests/decline", method: "POST", body: { id: ID } });
  expect(container.hidden).toBe(true);
});
