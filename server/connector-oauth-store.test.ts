import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretCodec } from "./secrets";
import { ConnectorError } from "./connectors";
import { ConnectorOAuthStore } from "./connector-oauth-store";

const CANARY = { access: "access_CANARY_7f3a", refresh: "refresh_CANARY_91bc", secret: "client_secret_CANARY_55de", verifier: "verifier_CANARY_0d2e" };
const ISSUER = "https://as.example";
const RESOURCE = "https://mcp.example/mcp";
const REDIRECT = "https://sessions.example.com/oauth/connectors/callback";

function fixture(options: { keyless?: boolean } = {}) {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  database.query("INSERT INTO mcp_connectors (id,name,slug,url,auth_mode,created_at) VALUES ('c','Svc','svc',?,'oauth',1)").run(RESOURCE);
  let clock = 1_000_000;
  const key = randomBytes(32);
  const store = new ConnectorOAuthStore({
    database, now: () => clock,
    codec: () => { if (options.keyless) throw new ConnectorError("storage", "no key"); return createSecretCodec(key); },
  });
  const pending = (overrides: Partial<Parameters<ConnectorOAuthStore["createPending"]>[0]> = {}) => store.createPending({
    connectorId: "c", epoch: 0, attempt: overrides.attempt ?? store.beginAttempt("c", overrides.epoch ?? 0), sessionHash: "session-a", issuer: ISSUER, resource: RESOURCE, clientId: "client-1",
    clientSecret: CANARY.secret, redirectUri: REDIRECT, verifier: CANARY.verifier, nonce: "n-1",
    registration: "dcr", tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke`, tokenAuthMethod: "client_secret_basic", scope: "read", ...overrides,
  });
  const grant = (epoch = 0) => store.commitGrant({
    connectorId: "c", epoch, issuer: ISSUER, resource: RESOURCE, clientId: "client-1", registration: "dcr", clientSecret: CANARY.secret,
    tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke`, tokenAuthMethod: "client_secret_basic",
    accessToken: CANARY.access, refreshToken: CANARY.refresh, expiresAt: clock + 3600_000, scope: "read", identity: null,
  });
  return { database, store, pending, grant, tick: (ms: number) => { clock += ms; } };
}

test("a missing encryption key fails before any pending flow or grant is written", () => {
  const f = fixture({ keyless: true });
  expect(() => f.pending()).toThrow(ConnectorError);
  expect(() => f.grant()).toThrow(ConnectorError);
  expect(f.database.query("SELECT COUNT(*) AS n FROM connector_oauth_pending").get()).toEqual({ n: 0 });
  expect(f.database.query("SELECT COUNT(*) AS n FROM connector_oauth_grants").get()).toEqual({ n: 0 });
});

test("pending state is single-use, short-lived, and bound to the initiating browser and epoch", () => {
  const f = fixture();
  const state = f.pending();
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const row = f.database.query("SELECT * FROM connector_oauth_pending").get() as Record<string, unknown>;
  expect(row.state_hash).not.toBe(state);
  expect(JSON.stringify(row)).not.toContain(CANARY.verifier);
  expect(JSON.stringify(row)).not.toContain(CANARY.secret);
  // Another browser can neither redeem nor burn it.
  expect(f.store.consumePending(state, "session-b")).toBeNull();
  const flow = f.store.consumePending(state, "session-a");
  expect(flow).toMatchObject({ connectorId: "c", epoch: 0, issuer: ISSUER, resource: RESOURCE, clientId: "client-1", redirectUri: REDIRECT, verifier: CANARY.verifier, clientSecret: CANARY.secret, nonce: "n-1",
    registration: "dcr", tokenEndpoint: `${ISSUER}/token`, revocationEndpoint: `${ISSUER}/revoke`, tokenAuthMethod: "client_secret_basic", scope: "read" });
  expect(f.store.consumePending(state, "session-a")).toBeNull();
  // Expired.
  const late = f.pending();
  f.tick(11 * 60_000);
  expect(f.store.consumePending(late, "session-a")).toBeNull();
  // Advanced epoch.
  const stale = f.pending();
  f.store.advanceEpoch("c");
  expect(f.store.consumePending(stale, "session-a")).toBeNull();
  // A flow cannot be started for an epoch that is no longer current.
  expect(() => f.pending({ epoch: 0 })).toThrow(ConnectorError);
});

test("grants commit and rotate only by epoch and version; stale writers cannot restore access", () => {
  const f = fixture();
  expect(f.grant()).toBe(true);
  const first = f.store.readGrant("c", 0)!;
  expect(first).toMatchObject({ version: 1, accessToken: CANARY.access, refreshToken: CANARY.refresh, scope: "read", tokenEndpoint: `${ISSUER}/token`, tokenAuthMethod: "client_secret_basic" });
  // One grant per epoch: a second callback for the same epoch cannot overwrite it.
  expect(f.grant()).toBe(false);
  expect(f.store.readGrant("c", 0)).toMatchObject({ version: 1, accessToken: CANARY.access });
  // Rotation with a stale version loses; a correct one wins and bumps the version.
  expect(f.store.rotate({ connectorId: "c", epoch: 0, version: 0, accessToken: "a2", expiresAt: 5 })).toBe(false);
  expect(f.store.rotate({ connectorId: "c", epoch: 0, version: 1, accessToken: "a2", expiresAt: 5 })).toBe(true);
  // A response without a new refresh token keeps the old one.
  expect(f.store.readGrant("c", 0)).toMatchObject({ version: 2, accessToken: "a2", refreshToken: CANARY.refresh });
  expect(f.store.rotate({ connectorId: "c", epoch: 0, version: 2, accessToken: "a3", refreshToken: "r3", expiresAt: 6 })).toBe(true);
  expect(f.store.readGrant("c", 0)).toMatchObject({ version: 3, refreshToken: "r3" });
  // Disconnect advances the epoch: the grant is gone, and late writers for the old epoch fail.
  const epoch = f.store.advanceEpoch("c");
  expect(epoch).toBe(1);
  expect(f.store.readGrant("c", 0)).toBeNull();
  expect(f.store.readGrant("c", 1)).toBeNull();
  expect(f.store.rotate({ connectorId: "c", epoch: 0, version: 3, accessToken: "late", expiresAt: 7 })).toBe(false);
  expect(f.grant(0)).toBe(false);
  expect(f.database.query("SELECT COUNT(*) AS n FROM connector_oauth_grants").get()).toEqual({ n: 0 });
  // Reconnect-required is version-gated too.
  expect(f.grant(1)).toBe(true);
  expect(f.store.markReconnect("c", 1, 0)).toBe(false);
  expect(f.store.markReconnect("c", 1, 1)).toBe(true);
  expect(f.store.status("c").state).toBe("reconnect_required");
  expect(f.store.readGrant("c", 1)).toBeNull();
  // A reconnect-required grant cannot be revived on its epoch; only a new epoch can sign in again.
  expect(f.grant(1)).toBe(false);
  expect(f.store.status("c").state).toBe("reconnect_required");
  expect(f.grant(f.store.advanceEpoch("c"))).toBe(true);
});

test("a sealed secret cannot be opened under another connector, epoch or purpose", () => {
  const f = fixture();
  f.grant();
  const row = f.database.query("SELECT access_token, refresh_token FROM connector_oauth_grants").get() as { access_token: string; refresh_token: string };
  // Swap the two ciphertexts: authenticated encryption must refuse both.
  f.database.query("UPDATE connector_oauth_grants SET access_token=?, refresh_token=?").run(row.refresh_token, row.access_token);
  expect(() => f.store.readGrant("c", 0)).toThrow(ConnectorError);
});

test("status never carries secrets, and connected-since is the local grant time", () => {
  const f = fixture();
  expect(f.store.status("c")).toEqual({ state: "disconnected", issuer: null, identity: null, connectedSince: null, expiresAt: null, registration: null, scope: null });
  f.grant();
  const status = f.store.status("c");
  expect(status).toMatchObject({ state: "connected", issuer: ISSUER, identity: null, connectedSince: 1_000_000, registration: "dcr", scope: "read" });
  f.tick(5000);
  f.store.rotate({ connectorId: "c", epoch: 0, version: 1, accessToken: "a2", expiresAt: 9 });
  expect(f.store.status("c").connectedSince).toBe(1_000_000);
  const text = JSON.stringify([status, f.store.status("c")]);
  for (const secret of Object.values(CANARY)) expect(text).not.toContain(secret);
});
