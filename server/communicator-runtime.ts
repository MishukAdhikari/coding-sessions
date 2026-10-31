import { db } from "./db";
import { Communicator } from "./communicator";
import { find } from "./mux";

/** Shared by launch preparation and HTTP serving; no dependency on the session launchers. */
export const communicator = new Communicator(db, {
  isLive: async identity => !!await find(identity.session_id.slice(2)),
});
