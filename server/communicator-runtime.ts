import { db } from "./db";
import { Communicator } from "./communicator";
import { Connectors } from "./connectors";
import { find } from "./mux";
import { config } from "./config";

/** Shared by launch preparation and HTTP serving; no dependency on the session launchers. */
export const communicator = new Communicator(db, {
  isLive: async identity => !!await find(identity.session_id.slice(2)),
});

/** Outbound connector gateway; same liveness rule as the communicator. */
export const connectors = new Connectors({
  database: db,
  isLive: async identity => !!await find(identity.session_id.slice(2)),
  dataDir: config.dataDir,
  // Local (stdio) connectors receive exactly the secrets the owner named, by name, and nothing else.
  secrets: async names => {
    const { secretStore } = await import("./secret-store");
    const env = await secretStore().sessionEnv();
    return Object.fromEntries(names.filter(name => typeof env[name] === "string").map(name => [name, env[name]!]));
  },
});
