import { readCsSetting } from "./environment";
import { isAbsolute, join, resolve } from "node:path";
import { isIP } from "node:net";
import { parseTrustedProxies } from "./http-security";

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
  // Loopback unless a container needs every interface; the reverse proxy stays in front either way.
  const listenHost = readCsSetting(env, "CS_LISTEN_HOST") ?? "127.0.0.1";
  if (!isIP(listenHost)) throw new Error("CS_LISTEN_HOST must be an IP address, such as 127.0.0.1 or 0.0.0.0.");
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
  // Optional loopback-only listener for the last-activity signal (server/activity-signal.ts).
  const activityValue = readCsSetting(env, "CS_ACTIVITY_PORT");
  const activityPort = activityValue ? Number(activityValue) : null;
  if (activityPort !== null && (!Number.isInteger(activityPort) || activityPort < 1 || activityPort > 65535 || activityPort === port)) {
    throw new Error("CS_ACTIVITY_PORT must be an integer from 1 to 65535, different from PORT.");
  }
  // Optional local control socket (server/control-socket.ts): a Unix socket, never TCP.
  const socketSwitch = readCsSetting(env, "CS_SOCKET");
  if (socketSwitch !== undefined && !["", "0", "1"].includes(socketSwitch)) throw new Error("CS_SOCKET must be 1 or 0.");
  const socketValue = readCsSetting(env, "CS_SOCKET_PATH");
  if (socketValue && !isAbsolute(socketValue)) throw new Error("CS_SOCKET_PATH must be an absolute path.");
  const socketPath = socketValue ? resolve(socketValue) : socketSwitch === "1" ? join(resolve(dataDir), "cs.sock") : null;
  // A Unix socket path must fit sun_path (104 bytes on macOS, 108 on Linux).
  if (socketPath && Buffer.byteLength(socketPath) >= 100) {
    throw new Error("The control socket path is too long (it must be under 100 bytes): set CS_SOCKET_PATH to a shorter path.");
  }
  return { port, listenHost, activityPort, socketPath, origin: origin.origin, rpId, cookieSecure, dataDir: resolve(dataDir),
    unrestrictedAgents: permissions === "unrestricted", repository, repoOwners, trustProxy: readCsSetting(env, "CS_TRUST_PROXY") === "1",
    trustedProxies: parseTrustedProxies(readCsSetting(env, "CS_TRUSTED_PROXIES")) };
}

export const config = readConfig(process.env);
