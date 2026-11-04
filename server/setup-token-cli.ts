/**
 * Prints a one-time sign-in link. Run as the instance's service account with its
 * environment, e.g. by `coding-sessions setup-link`; it never logs the token.
 */
import { config } from "./config";
import { deleteMeta, getMeta, setMeta } from "./db";
import { createSetupToken, SETUP_TOKEN_TTL_MS } from "./setup-token";

const token = createSetupToken({ get: getMeta, set: setMeta, delete: deleteMeta });
console.log(`${config.origin}/#setup=${token}`);
console.error(`Opens once and expires in ${SETUP_TOKEN_TTL_MS / 60_000} minutes. A new link replaces this one.`);
