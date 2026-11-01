import type { Database } from "bun:sqlite";

function addColumn(database: Database, sql: string): void {
  try { database.exec(sql); } catch {}
}

/** Apply the additive schema to both fresh and legacy databases. */
export function applyDatabaseSchema(database: Database): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS credentials (
      id         INTEGER PRIMARY KEY,
      cred_id    TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL,
      counter    INTEGER NOT NULL DEFAULT 0,
      transports TEXT,
      label      TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
      id         INTEGER PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      ua         TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id    INTEGER PRIMARY KEY,
      path  TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS launches (
      screen            TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      project_path      TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      claude_url        TEXT,
      resume_id         TEXT,
      remote_control    INTEGER NOT NULL DEFAULT 1,
      provider          TEXT NOT NULL DEFAULT 'claude',
      launch_id         TEXT,
      phase             TEXT NOT NULL DEFAULT 'ready',
      error_message     TEXT,
      resume_archive_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS chat_deletions (
      id         INTEGER PRIMARY KEY,
      sid        TEXT NOT NULL UNIQUE,
      status     TEXT NOT NULL DEFAULT 'pending',
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      done_at    INTEGER
    );

    CREATE TABLE IF NOT EXISTS archive (
      id             INTEGER PRIMARY KEY,
      name           TEXT NOT NULL,
      project_path   TEXT,
      claude_url     TEXT,
      resume_id      TEXT,
      model          TEXT,
      remote_control INTEGER NOT NULL DEFAULT 1,
      provider       TEXT NOT NULL DEFAULT 'claude',
      started_at     INTEGER,
      ended_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cli_tokens (
      id           INTEGER PRIMARY KEY,
      token_hash   TEXT NOT NULL UNIQUE,
      label        TEXT,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);

  // A passkey is only usable under the relying party it was registered with, so the
  // RP has to travel with the credential — otherwise a domain move leaves rows that
  // look like working passkeys and can never authenticate again.
  addColumn(database, "ALTER TABLE credentials ADD COLUMN rp_id TEXT");
  addColumn(database, "ALTER TABLE launches ADD COLUMN claude_url TEXT");
  addColumn(database, "ALTER TABLE launches ADD COLUMN resume_id TEXT");
  addColumn(database, "ALTER TABLE archive ADD COLUMN resume_id TEXT");
  addColumn(database, "ALTER TABLE archive ADD COLUMN model TEXT");
  addColumn(database, "ALTER TABLE launches ADD COLUMN remote_control INTEGER NOT NULL DEFAULT 1");
  addColumn(database, "ALTER TABLE archive ADD COLUMN remote_control INTEGER NOT NULL DEFAULT 1");
  addColumn(database, "ALTER TABLE launches ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
  addColumn(database, "ALTER TABLE archive ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude'");
  addColumn(database, "ALTER TABLE launches ADD COLUMN launch_id TEXT");
  addColumn(database, "ALTER TABLE launches ADD COLUMN phase TEXT NOT NULL DEFAULT 'ready'");
  addColumn(database, "ALTER TABLE launches ADD COLUMN error_message TEXT");
  addColumn(database, "ALTER TABLE launches ADD COLUMN resume_archive_id INTEGER");

  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS launches_launch_id_idx ON launches (launch_id);

    CREATE TABLE IF NOT EXISTS communicator_credentials (
      launch_id  TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS communicator_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      sender_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      sender_json TEXT NOT NULL,
      recipient_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to TEXT,
      created_at INTEGER NOT NULL,
      received_at INTEGER,
      UNIQUE (sender_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS communicator_inbox_idx ON communicator_messages (recipient_id, sequence);
    CREATE INDEX IF NOT EXISTS communicator_sent_idx ON communicator_messages (sender_id, sequence);
    CREATE INDEX IF NOT EXISTS communicator_rate_idx ON communicator_messages (sender_id, created_at);

    CREATE TABLE IF NOT EXISTS codex_launch_state (
      launch_id     TEXT PRIMARY KEY REFERENCES launches(launch_id) ON DELETE CASCADE,
      screen        TEXT NOT NULL,
      session_id    TEXT,
      model         TEXT,
      turn_state    TEXT NOT NULL DEFAULT 'starting',
      last_event    TEXT,
      canonical_cwd TEXT NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS codex_launch_state_screen_idx ON codex_launch_state (screen);

    -- Operator-registered CLI agents. args is a JSON array of discrete strings, never
    -- a shell string: the launch line quotes each token exactly once.
    CREATE TABLE IF NOT EXISTS custom_commands (
      id         INTEGER PRIMARY KEY,
      slug       TEXT NOT NULL UNIQUE,
      label      TEXT NOT NULL,
      bin        TEXT NOT NULL,
      args       TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
  `);

  // Per-Command credential: the env var its CLI reads, and the token to put in it.
  // Added after the CREATE above — an ALTER against a table that does not exist yet
  // fails silently through addColumn and leaves the columns missing.
  // The token is write-only over the API and never travels in argv (see sessions.ts).
  addColumn(database, "ALTER TABLE custom_commands ADD COLUMN env_var TEXT");
  addColumn(database, "ALTER TABLE custom_commands ADD COLUMN token TEXT");

  // MCP connector OAuth (see server/oauth.ts). Clients register themselves; codes and
  // tokens are stored only as hashes, like auth_sessions and cli_tokens.
  database.exec(`
    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id     TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      redirect_uris TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_codes (
      code_hash      TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      redirect_uri   TEXT NOT NULL,
      code_challenge TEXT NOT NULL,
      resource       TEXT,
      expires_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id           INTEGER PRIMARY KEY,
      token_hash   TEXT NOT NULL UNIQUE,
      kind         TEXT NOT NULL,
      client_id    TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
      resource     TEXT,
      created_at   INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);

  // Outbound MCP connectors (Coding Sessions → another service). Separate from the
  // inbound oauth_* tables above. credential is always AES-GCM sealed; see connectors.ts.
  migratePresetConnectors(database);
  database.exec(`
    CREATE TABLE IF NOT EXISTS mcp_connectors (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      slug              TEXT NOT NULL UNIQUE,
      url               TEXT NOT NULL DEFAULT '',
      enabled           INTEGER NOT NULL DEFAULT 1,
      credential        TEXT,
      credential_set_at INTEGER,
      granted_tools     TEXT NOT NULL DEFAULT '[]',
      default_providers TEXT NOT NULL DEFAULT '[]',
      catalog           TEXT,
      catalog_at        INTEGER,
      catalog_stale     INTEGER NOT NULL DEFAULT 0,
      server_info       TEXT,
      check_status      TEXT,
      check_detail      TEXT,
      check_at          INTEGER,
      check_ok_at       INTEGER,
      created_at        INTEGER NOT NULL,
      auth_mode         TEXT NOT NULL DEFAULT 'none',
      auth_epoch        INTEGER NOT NULL DEFAULT 0,
      token_version     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS connector_capabilities (
      launch_id  TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS connector_launch_grants (
      connector_id TEXT NOT NULL REFERENCES mcp_connectors(id) ON DELETE CASCADE,
      launch_id    TEXT NOT NULL,
      granted_at   INTEGER NOT NULL,
      PRIMARY KEY (connector_id, launch_id)
    );

    CREATE TABLE IF NOT EXISTS connector_audit (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      at           INTEGER NOT NULL,
      connector_id TEXT NOT NULL,
      launch_id    TEXT,
      provider     TEXT,
      session_name TEXT,
      tool         TEXT NOT NULL,
      outcome      TEXT NOT NULL,
      duration_ms  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS connector_audit_at_idx ON connector_audit (connector_id, at);
  `);

  // Auth mode is explicit: an existing token means bearer, none means anonymous. auth_epoch
  // changes with URL, mode, account or disconnect and invalidates everything bound to it;
  // token_version changes only when an OAuth grant is refreshed. See connector-oauth-store.ts.
  addColumn(database, "ALTER TABLE mcp_connectors ADD COLUMN auth_mode TEXT NOT NULL DEFAULT 'none'");
  addColumn(database, "ALTER TABLE mcp_connectors ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0");
  addColumn(database, "ALTER TABLE mcp_connectors ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");
  database.exec(`
    UPDATE mcp_connectors SET auth_mode='bearer' WHERE auth_mode='none' AND credential IS NOT NULL;

    -- Every secret column is sealed with AAD bound to connector, epoch and purpose.
    CREATE TABLE IF NOT EXISTS connector_oauth_grants (
      connector_id    TEXT PRIMARY KEY REFERENCES mcp_connectors(id) ON DELETE CASCADE,
      auth_epoch      INTEGER NOT NULL,
      token_version   INTEGER NOT NULL,
      status          TEXT NOT NULL,
      issuer          TEXT NOT NULL,
      resource        TEXT NOT NULL,
      client_id       TEXT NOT NULL,
      registration    TEXT NOT NULL,
      -- Frozen from the authorization-server metadata accepted at sign-in; never re-derived later.
      token_endpoint      TEXT NOT NULL,
      revocation_endpoint TEXT,
      token_auth_method   TEXT NOT NULL,
      client_secret   TEXT,
      access_token    TEXT,
      refresh_token   TEXT,
      expires_at      INTEGER,
      scope           TEXT,
      identity        TEXT,
      connected_since INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );

    -- Only a hash of the state is stored; it is single-use and bound to the initiating browser session.
    CREATE TABLE IF NOT EXISTS connector_oauth_pending (
      state_hash    TEXT PRIMARY KEY,
      connector_id  TEXT NOT NULL REFERENCES mcp_connectors(id) ON DELETE CASCADE,
      auth_epoch    INTEGER NOT NULL,
      session_hash  TEXT NOT NULL,
      issuer        TEXT NOT NULL,
      resource      TEXT NOT NULL,
      client_id     TEXT NOT NULL,
      client_secret TEXT,
      redirect_uri  TEXT NOT NULL,
      registration        TEXT NOT NULL,
      token_endpoint      TEXT NOT NULL,
      revocation_endpoint TEXT,
      token_auth_method   TEXT NOT NULL,
      scope               TEXT,
      verifier      TEXT NOT NULL,
      nonce         TEXT,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      consumed_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS connector_oauth_pending_connector_idx ON connector_oauth_pending (connector_id);
  `);
  // A client the operator registered with the provider (secret sealed, origin-bound), and
  // metadata frozen at sign-in that later identity checks need: whether the provider promises an
  // iss parameter on the callback (RFC 9207), and its JWKS and UserInfo endpoints.
  addColumn(database, "ALTER TABLE mcp_connectors ADD COLUMN oauth_client_id TEXT");
  addColumn(database, "ALTER TABLE mcp_connectors ADD COLUMN oauth_client_secret TEXT");
  // The exact issuer that client belongs to, pinned explicitly or at first sign-in.
  addColumn(database, "ALTER TABLE mcp_connectors ADD COLUMN oauth_client_issuer TEXT");
  addColumn(database, "ALTER TABLE connector_oauth_pending ADD COLUMN iss_parameter INTEGER NOT NULL DEFAULT 0");
  // Set while a refresh request may be in flight; found set with no refresh running (a restart
  // mid-refresh), the grant needs a new sign-in rather than a retry with a possibly rotated token.
  addColumn(database, "ALTER TABLE connector_oauth_grants ADD COLUMN refresh_pending INTEGER NOT NULL DEFAULT 0");
  // Verified claims of the original sign-in (subject, audience, nonce, auth_time), never the raw ID token.
  addColumn(database, "ALTER TABLE connector_oauth_grants ADD COLUMN oidc_context TEXT");
  // Sign-in attempt generation: each start takes the next number, and only the latest attempt may
  // create its pending row, complete, or commit. It does not touch the current grant.
  addColumn(database, "ALTER TABLE mcp_connectors ADD COLUMN oauth_attempt INTEGER NOT NULL DEFAULT 0");
  addColumn(database, "ALTER TABLE connector_oauth_pending ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
  for (const table of ["connector_oauth_pending", "connector_oauth_grants"]) {
    addColumn(database, `ALTER TABLE ${table} ADD COLUMN jwks_uri TEXT`);
    addColumn(database, `ALTER TABLE ${table} ADD COLUMN userinfo_endpoint TEXT`);
  }
}

/**
 * The first release stored connectors as fixed presets (a `preset` column, no URL). Convert
 * those rows in place, keeping id, grants and audit: the preset name becomes the name and the
 * permanent tool namespace, the URL is left empty, and the row is disabled until the operator
 * enters a URL. The old token is kept sealed but is cleared when a URL is set, because the
 * destination it was entered for is not recorded.
 */
function migratePresetConnectors(database: Database): void {
  const columns = database.query("PRAGMA table_info(mcp_connectors)").all() as Array<{ name: string }>;
  if (!columns.some(column => column.name === "preset")) return;
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    database.transaction(() => {
      database.exec(`
        CREATE TABLE mcp_connectors_v2 (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, url TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1, credential TEXT, credential_set_at INTEGER,
          granted_tools TEXT NOT NULL DEFAULT '[]', default_providers TEXT NOT NULL DEFAULT '[]',
          catalog TEXT, catalog_at INTEGER, catalog_stale INTEGER NOT NULL DEFAULT 0, server_info TEXT,
          check_status TEXT, check_detail TEXT, check_at INTEGER, check_ok_at INTEGER, created_at INTEGER NOT NULL
        );
        INSERT INTO mcp_connectors_v2 (id,name,slug,url,enabled,credential,credential_set_at,granted_tools,default_providers,catalog,catalog_at,catalog_stale,created_at)
          SELECT id, preset, lower(preset), '', 0, credential, credential_set_at, granted_tools, default_providers, catalog, catalog_at, 1, created_at FROM mcp_connectors;
        DROP TABLE mcp_connectors;
        ALTER TABLE mcp_connectors_v2 RENAME TO mcp_connectors;
      `);
      const broken = database.query("PRAGMA foreign_key_check").all();
      if (broken.length) throw new Error("Connector migration left dangling grants.");
    })();
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}
