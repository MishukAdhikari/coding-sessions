import { readCsSetting } from "./environment";
import { isAbsolute, resolve } from "node:path";

type Environment = Record<string, string | undefined>;

export function readConfig(env: Environment) {
  const port = Number(env.PORT ?? 9121);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer from 1 to 65535.");
  const origin = new URL(env.ORIGIN ?? `http://localhost:${port}`);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && local))
    || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") {
    throw new Error("ORIGIN must be an HTTPS origin without a path; HTTP is allowed only on loopback for development.");
  }
  const rpId = env.RP_ID ?? origin.hostname;
  if (!rpId || (!local && !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(rpId))
    || !(origin.hostname === rpId || origin.hostname.endsWith(`.${rpId}`))) {
    throw new Error("RP_ID must match the origin hostname or a parent domain.");
  }
  const cookieSecure = env.COOKIE_SECURE !== "0";
  if (!cookieSecure && !local) throw new Error("Secure cookies cannot be disabled for a non-loopback origin.");
  const permissions = readCsSetting(env, "CS_AGENT_PERMISSIONS") ?? "standard";
  if (!["standard", "unrestricted"].includes(permissions)) throw new Error("CS_AGENT_PERMISSIONS must be standard or unrestricted.");
  const dataDir = readCsSetting(env, "CS_DATA_DIR") ?? new URL("../data", import.meta.url).pathname;
  if (!isAbsolute(dataDir)) throw new Error("CS_DATA_DIR must be an absolute path.");
  const repository = readCsSetting(env, "CS_DEFAULT_REPO") ?? "";
  if (repository && !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("CS_DEFAULT_REPO must be owner/repository.");
  const repoOwners = (readCsSetting(env, "CS_GITHUB_OWNERS") ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (repoOwners.some(owner => !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner))) throw new Error("CS_GITHUB_OWNERS must contain comma-separated GitHub owners.");
  return { port, origin: origin.origin, rpId, cookieSecure, dataDir: resolve(dataDir),
    unrestrictedAgents: permissions === "unrestricted", repository, repoOwners, trustProxy: readCsSetting(env, "CS_TRUST_PROXY") === "1" };
}

export const config = readConfig(process.env);
