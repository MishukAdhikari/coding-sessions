import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretCodec } from "./secrets";
import { createSecretStore, fetchSource, reservedName, SecretStoreError, SNAPSHOT_FRESH_MS, validateSourceConfig, type SourceDependencies } from "./secret-store";
import { handleSecretsRoute } from "./secrets-route";
import { safeFetch } from "./connector-net";

const freshDb = () => { const database = new Database(":memory:"); applyDatabaseSchema(database); return database; };
const codec = () => createSecretCodec(randomBytes(32));
const noSources: SourceDependencies = {
  fetch: (async () => { throw new Error("no network in tests"); }) as unknown as typeof fetch,
  runBws: async () => ({ code: 127, out: "" }),
};
function store(overrides: Partial<Parameters<typeof createSecretStore>[0]> = {}) {
  let clock = 1_000;
  const database = overrides.database ?? freshDb();
  const s = createSecretStore({ database, codec: codec(), sources: noSources, now: () => clock, ...overrides });
  return { s, database, tick: (ms: number) => { clock += ms; } };
}
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

/* ---------- built-in store ---------- */

test("a stored secret is sealed at rest and reaches the session environment", async () => {
  const { s, database } = store();
  s.set("OPENAI_API_KEY", "sk-test-123");
  const raw = database.query("SELECT value FROM secrets WHERE name = 'OPENAI_API_KEY'").get() as { value: string };
  expect(raw.value.startsWith("cs:secret:v1:")).toBe(true);
  expect(raw.value).not.toContain("sk-test-123");
  expect(await s.sessionEnv()).toEqual({ OPENAI_API_KEY: "sk-test-123" });
});

test("the list never carries a value", () => {
  const { s } = store();
  s.set("API_TOKEN", "super-secret-value");
  const listed = JSON.stringify(s.list());
  expect(listed).toContain("API_TOKEN");
  expect(listed).not.toContain("super-secret-value");
});

test("replacing a secret keeps one row with the new value", async () => {
  const { s, database } = store();
  s.set("TOKEN", "one");
  s.set("TOKEN", "two");
  expect((database.query("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n).toBe(1);
  expect(await s.sessionEnv()).toEqual({ TOKEN: "two" });
  expect(s.remove("TOKEN")).toBe(true);
  expect(await s.sessionEnv()).toEqual({});
});

test("names must be env vars and must not shadow what the server or session needs", () => {
  const { s } = store();
  for (const name of ["lower_case", "1ABC", "WITH-DASH", "", "A".repeat(65)]) expect(() => s.set(name, "x")).toThrow(SecretStoreError);
  for (const name of ["PATH", "HOME", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "CS_COMMUNICATOR_TOKEN", "CS_CONNECTOR_TOKEN", "BASH_ENV", "BASH_FUNC_X", "ZMX_DIR", "XDG_CONFIG_HOME", "NODE_OPTIONS", "CREDENTIALS_DIRECTORY"]) {
    expect(reservedName(name)).toBe(true);
    expect(() => s.set(name, "x")).toThrow(/used by the server/);
  }
  expect(() => s.set("GOOD_NAME", "")).toThrow(SecretStoreError);
  expect(() => s.set("GOOD_NAME", "a\u0000b")).toThrow(SecretStoreError);
});

test("without the encryption key nothing is written", () => {
  const { s, database } = store({ codec: createSecretCodec(null) });
  expect(() => s.set("TOKEN", "value")).toThrow(/encryption key/);
  expect((database.query("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n).toBe(0);
});

/* ---------- sources ---------- */

test("Vault KV v2: reads data.data, filters unusable keys, sends the token as a header", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const deps: SourceDependencies = {
    ...noSources,
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return jsonResponse({ data: { data: { GITHUB_TOKEN: "ghp_x", lower: "skip", PATH: "/evil", EMPTY: "" } } });
    }) as unknown as typeof fetch,
  };
  const config = validateSourceConfig("vault", { address: "https://vault.example.com/", path: "/apps/sessions/", namespace: "team" });
  expect(config).toEqual({ address: "https://vault.example.com", mount: "secret", path: "apps/sessions", namespace: "team" });
  expect(await fetchSource("vault", config, "hvs.token", deps)).toEqual({ GITHUB_TOKEN: "ghp_x" });
  expect(seen[0]!.url).toBe("https://vault.example.com/v1/secret/data/apps/sessions");
  expect(seen[0]!.headers["x-vault-token"]).toBe("hvs.token");
  expect(seen[0]!.headers["x-vault-namespace"]).toBe("team");
});

test("Infisical: logs in with universal auth, then lists; the path's own secrets beat imports", async () => {
  const calls: string[] = [];
  const deps: SourceDependencies = {
    ...noSources,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push(url);
      if (url.endsWith("/api/v1/auth/universal-auth/login")) {
        expect(JSON.parse(init.body as string)).toEqual({ clientId: "client-1", clientSecret: "client-secret-value" });
        return jsonResponse({ accessToken: "jwt-1", tokenType: "Bearer" });
      }
      expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
      return jsonResponse({
        secrets: [{ secretKey: "STRIPE_KEY", secretValue: "own" }],
        imports: [{ secrets: [{ secretKey: "STRIPE_KEY", secretValue: "imported" }, { secretKey: "SENTRY_DSN", secretValue: "dsn" }] }],
      });
    }) as unknown as typeof fetch,
  };
  const config = validateSourceConfig("infisical", { clientId: "client-1", projectId: "proj-1" });
  expect(config).toMatchObject({ siteUrl: "https://app.infisical.com", environment: "prod", secretPath: "/" });
  expect(await fetchSource("infisical", config, "client-secret-value", deps)).toEqual({ STRIPE_KEY: "own", SENTRY_DSN: "dsn" });
  expect(calls[1]).toContain("/api/v4/secrets?projectId=proj-1&environment=prod");
});

test("Bitwarden: runs bws with the token in its environment, never argv", async () => {
  let argv: string[] = [];
  let env: Record<string, string> = {};
  const deps: SourceDependencies = {
    ...noSources,
    runBws: async (a, e) => { argv = a; env = e; return { code: 0, out: JSON.stringify([{ key: "NPM_TOKEN", value: "npm_x" }, { key: "not-env", value: "y" }]) }; },
  };
  const projectId = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const config = validateSourceConfig("bitwarden", { projectId });
  expect(await fetchSource("bitwarden", config, "0.access.token", deps)).toEqual({ NPM_TOKEN: "npm_x" });
  expect(argv).toEqual(["bws", "secret", "list", projectId, "--output", "json"]);
  expect(argv.join(" ")).not.toContain("0.access.token");
  expect(env).toEqual({ BWS_ACCESS_TOKEN: "0.access.token" });
});

test("source config rejects plain http, private addresses and path tricks", () => {
  expect(() => validateSourceConfig("vault", { address: "http://vault.example.com", path: "a" })).toThrow(/https/);
  expect(() => validateSourceConfig("vault", { address: "https://10.0.0.5", path: "a" })).toThrow(SecretStoreError);
  expect(() => validateSourceConfig("vault", { address: "https://vault.example.com", path: "../sys" })).toThrow(SecretStoreError);
  expect(() => validateSourceConfig("bitwarden", { projectId: "not-a-uuid" })).toThrow(/UUID/);
  expect(() => validateSourceConfig("infisical", { clientId: "", projectId: "p" })).toThrow(SecretStoreError);
});

test("a source is saved only after a successful fetch; failures echo no upstream text", async () => {
  let status = 403;
  const deps: SourceDependencies = {
    ...noSources,
    fetch: (async () => status === 200 ? jsonResponse({ data: { data: { A_KEY: "a" } } }) : new Response("token hvs.leaked is bad", { status })) as unknown as typeof fetch,
  };
  const { s, database } = store({ sources: deps });
  const input = { kind: "vault", config: { address: "https://vault.example.com", path: "app" }, credential: "hvs.leaked" };
  const failed = (await s.addSource(input).catch(error => error)) as Error;
  expect(failed).toBeInstanceOf(SecretStoreError);
  expect(failed.message).not.toContain("hvs.leaked");
  expect((database.query("SELECT COUNT(*) AS n FROM secret_sources").get() as { n: number }).n).toBe(0);

  status = 200;
  const source = await s.addSource(input);
  expect(source).toMatchObject({ kind: "vault", label: "Vault", names: ["A_KEY"], lastError: null });
  expect(JSON.stringify(source)).not.toContain("hvs.leaked");
  const row = database.query("SELECT credential, snapshot FROM secret_sources").get() as { credential: string; snapshot: string };
  expect(row.credential.startsWith("cs:secret:v1:")).toBe(true);
  expect(row.snapshot.startsWith("cs:secret:v1:")).toBe(true);
});

test("session env: sources, then built-in secrets on top; a down source falls back to its snapshot", async () => {
  let value = "from-vault";
  let up = true;
  let fetches = 0;
  const deps: SourceDependencies = {
    ...noSources,
    fetch: (async () => {
      fetches++;
      if (!up) throw new Error("ECONNREFUSED");
      return jsonResponse({ data: { data: { SHARED: value, ONLY_VAULT: value } } });
    }) as unknown as typeof fetch,
  };
  const { s, tick } = store({ sources: deps });
  const source = await s.addSource({ kind: "vault", config: { address: "https://vault.example.com", path: "app" }, credential: "hvs.token" });
  s.set("SHARED", "typed-here");
  expect(await s.sessionEnv()).toEqual({ SHARED: "typed-here", ONLY_VAULT: "from-vault" });
  expect(fetches).toBe(1); // the fresh snapshot was used, no refetch

  tick(SNAPSHOT_FRESH_MS + 1);
  value = "rotated";
  expect((await s.sessionEnv()).ONLY_VAULT).toBe("rotated");

  tick(SNAPSHOT_FRESH_MS + 1);
  up = false;
  expect((await s.sessionEnv()).ONLY_VAULT).toBe("rotated");
  expect(s.list().sources[0]!.lastError).toBe("The source could not be reached.");
  await expect(s.syncSource(source.id)).rejects.toThrow(SecretStoreError);

  expect(s.removeSource(source.id)).toBe(true);
  expect(await s.sessionEnv()).toEqual({ SHARED: "typed-here" });
});

test("without the encryption key a source is not saved either", async () => {
  const deps: SourceDependencies = { ...noSources, fetch: (async () => jsonResponse({ data: { data: { A_KEY: "a" } } })) as unknown as typeof fetch };
  const { s, database } = store({ codec: createSecretCodec(null), sources: deps });
  await expect(s.addSource({ kind: "vault", config: { address: "https://vault.example.com", path: "app" }, credential: "hvs.token-value" })).rejects.toThrow(/encryption key/);
  expect((database.query("SELECT COUNT(*) AS n FROM secret_sources").get() as { n: number }).n).toBe(0);
});

test("a manager whose name resolves to a private address is refused by the connector transport", async () => {
  const sources: SourceDependencies = {
    ...noSources,
    fetch: safeFetch({ policy: { allowLoopback: false }, role: "oauth", env: {}, resolver: async () => [{ address: "10.0.0.5", family: 4 }] }),
  };
  const { s, database } = store({ sources });
  const failed = (await s.addSource({ kind: "vault", config: { address: "https://vault.example.com", path: "app" }, credential: "hvs.token-value" }).catch(error => error)) as Error;
  expect(failed).toBeInstanceOf(SecretStoreError);
  expect(failed.message).toMatch(/private, local or reserved/);
  expect(failed.message).not.toContain("hvs.token-value");
  expect((database.query("SELECT COUNT(*) AS n FROM secret_sources").get() as { n: number }).n).toBe(0);
});

test("precedence: later sources beat earlier ones, a value stored here beats every source", async () => {
  const answers: Record<string, Record<string, string>> = {
    "https://one.example.com/v1/secret/data/app": { SHARED: "one", ONLY_ONE: "1" },
    "https://two.example.com/v1/secret/data/app": { SHARED: "two", TYPED: "from-two" },
  };
  const deps: SourceDependencies = { ...noSources, fetch: (async (url: string) => jsonResponse({ data: { data: answers[url] } })) as unknown as typeof fetch };
  const { s } = store({ sources: deps });
  await s.addSource({ kind: "vault", config: { address: "https://one.example.com", path: "app" }, credential: "hvs.one-token" });
  await s.addSource({ kind: "vault", config: { address: "https://two.example.com", path: "app" }, credential: "hvs.two-token" });
  s.set("TYPED", "typed-here");
  expect(await s.sessionEnv()).toEqual({ SHARED: "two", ONLY_ONE: "1", TYPED: "typed-here" });
});

/* ---------- route ---------- */

test("the route needs a browser session and the same origin, and never returns a value", async () => {
  const { s } = store();
  const deps = (browser: boolean, bearer = false) => ({
    cookieName: "cs", origin: "https://app.example", store: () => s,
    checkBrowserSession: () => browser, isAuthenticated: () => browser || bearer,
  });
  const req = (method: string, path: string, body?: unknown, origin = "https://app.example") =>
    new Request(`https://app.example${path}`, { method, headers: { cookie: "cs=abc", origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  expect((await handleSecretsRoute(req("GET", "/api/secrets"), deps(false)))!.status).toBe(401);
  expect((await handleSecretsRoute(req("GET", "/api/secrets"), deps(false, true)))!.status).toBe(403);
  expect((await handleSecretsRoute(req("PUT", "/api/secrets/TOKEN", { value: "v" }, "https://evil.example"), deps(true)))!.status).toBe(403);
  expect(await handleSecretsRoute(req("GET", "/api/other"), deps(true))).toBeNull();

  const put = await handleSecretsRoute(req("PUT", "/api/secrets/TOKEN", { value: "the-value" }), deps(true));
  expect(put!.status).toBe(200);
  expect(await put!.text()).not.toContain("the-value");
  const list = await handleSecretsRoute(req("GET", "/api/secrets"), deps(true));
  const text = await list!.text();
  expect(text).toContain("TOKEN");
  expect(text).not.toContain("the-value");
  expect((await handleSecretsRoute(req("PUT", "/api/secrets/PATH", { value: "x" }), deps(true)))!.status).toBe(422);
  expect((await handleSecretsRoute(req("DELETE", "/api/secrets/TOKEN"), deps(true)))!.status).toBe(200);
  expect((await handleSecretsRoute(req("DELETE", "/api/secrets/TOKEN"), deps(true)))!.status).toBe(404);
  expect((await handleSecretsRoute(req("DELETE", "/api/secrets/TOKEN", undefined, "https://evil.example"), deps(true)))!.status).toBe(403);
});

test("source routes need the same browser session and origin, and never echo the credential", async () => {
  const deps: SourceDependencies = { ...noSources, fetch: (async () => jsonResponse({ data: { data: { A_KEY: "a" } } })) as unknown as typeof fetch };
  const { s } = store({ sources: deps });
  const routeDeps = (browser: boolean, bearer = false) => ({
    cookieName: "cs", origin: "https://app.example", store: () => s,
    checkBrowserSession: () => browser, isAuthenticated: () => browser || bearer,
  });
  const req = (method: string, path: string, body?: unknown, origin = "https://app.example") =>
    new Request(`https://app.example${path}`, { method, headers: { cookie: "cs=abc", origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const input = { kind: "vault", config: { address: "https://vault.example.com", path: "app" }, credential: "hvs.route-credential" };

  expect((await handleSecretsRoute(req("POST", "/api/secret-sources", input), routeDeps(false, true)))!.status).toBe(403);
  expect((await handleSecretsRoute(req("POST", "/api/secret-sources", input, "https://evil.example"), routeDeps(true)))!.status).toBe(403);
  const added = await handleSecretsRoute(req("POST", "/api/secret-sources", input), routeDeps(true));
  expect(added!.status).toBe(200);
  const addedText = await added!.text();
  expect(addedText).not.toContain("hvs.route-credential");
  const { source } = JSON.parse(addedText) as { source: { id: number } };
  const synced = await handleSecretsRoute(req("POST", `/api/secret-sources/${source.id}/sync`), routeDeps(true));
  expect(synced!.status).toBe(200);
  const listed = await (await handleSecretsRoute(req("GET", "/api/secrets"), routeDeps(true)))!.text();
  expect(listed).not.toContain("hvs.route-credential");
  expect(listed).not.toContain("\"a\"");
  expect((await handleSecretsRoute(req("DELETE", `/api/secret-sources/${source.id}`), routeDeps(true)))!.status).toBe(200);
  expect((await handleSecretsRoute(req("DELETE", `/api/secret-sources/${source.id}`), routeDeps(true)))!.status).toBe(404);
});
