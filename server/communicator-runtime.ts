import { db } from "./db";
import { Communicator } from "./communicator";
import { Connectors } from "./connectors";
import { find } from "./mux";

/** Shared by launch preparation and HTTP serving; no dependency on the session launchers. */
export const communicator = new Communicator(db, {
  isLive: async identity => !!await find(identity.session_id.slice(2)),
});

/** Outbound connector gateway; same liveness rule as the communicator. */
export const connectors = new Connectors({
  database: db,
  isLive: async identity => !!await find(identity.session_id.slice(2)),
});
