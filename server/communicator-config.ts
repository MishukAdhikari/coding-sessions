import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const CONNECTOR = "coding_sessions_communicator";
const OWNERSHIP = "_codingSessionsCommunicator";
const GATEWAY = "coding_sessions_connectors";
const GATEWAY_OWNERSHIP = "_codingSessionsConnectors";
export interface Paths { bunPath?: string; bridgePath?: string; connectorBridgePath?: string }
interface Options extends Paths { home?: string; commandCodeBin?: string; connectors?: boolean }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function physicalProjectPath(cwd: string): string {
  let existing = resolve(cwd);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(existing), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(existing) === existing) throw error;
      missing.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
}
export function entry(paths: Paths = {}) {
  return { type: "stdio", command: paths.bunPath ?? process.execPath,
    args: [paths.bridgePath ?? fileURLToPath(new URL("./communicator-stdio.ts", import.meta.url))],
    env: { CS_COMMUNICATOR_TOKEN: "${CS_COMMUNICATOR_TOKEN}", CS_COMMUNICATOR_URL: "${CS_COMMUNICATOR_URL}" } };
}
export function gatewayEntry(paths: Paths = {}) {
  return { type: "stdio", command: paths.bunPath ?? process.execPath,
    args: [paths.connectorBridgePath ?? fileURLToPath(new URL("./connector-stdio.ts", import.meta.url))],
    env: { CS_CONNECTOR_TOKEN: "${CS_CONNECTOR_TOKEN}", CS_CONNECTOR_URL: "${CS_CONNECTOR_URL}" } };
}
export function communicatorEnvironment(token: string, port: number, connectorToken: string | null = null): Record<string, string> {
  return { CS_COMMUNICATOR_TOKEN: token, CS_COMMUNICATOR_URL: `http://127.0.0.1:${port}/mcp/communicator`,
    ...(connectorToken ? { CS_CONNECTOR_TOKEN: connectorToken, CS_CONNECTOR_URL: `http://127.0.0.1:${port}/mcp/connectors` } : {}) };
}

/** Create each directory under home as a private, real directory (never through a symlink). */
function privateDirectory(home: string, parts: string[], label: string): string {
  let directory = home;
  for (const part of parts) {
    directory = join(directory, part);
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error(`${label} configuration directories must not be symlinks.`);
  }
  return directory;
}

/**
 * Reconcile the app-owned MCP entries into an agent's JSON config file. Each entry
 * carries its own ownership record; an operator-edited entry is never overwritten or
 * removed, and everything else in the file is kept as it was.
 */
export function reconcileMcpConfig(file: string, entries: { communicator: unknown; gateway: unknown | null }, label: string): void {
  let config: Record<string, unknown> = {};
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error(`${label} MCP configuration must be a regular JSON file smaller than 1 MiB.`);
      const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!object(parsed) || (parsed.mcpServers !== undefined && !object(parsed.mcpServers))) throw new Error(`${label} MCP configuration must contain an object.`);
      config = parsed;
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Cannot safely update ${label} MCP configuration; repair its JSON, symlink, or permissions first.`);
  }
  const servers = { ...(config.mcpServers ?? {}) as Record<string, unknown> };
  const next: Record<string, unknown> = { ...config };
  let changed = false;
  const reconcile = (name: string, ownershipKey: string, wanted: unknown | null, kind: string) => {
    const ownership = config[ownershipKey];
    const owned = object(ownership) && ownership.version === 1 && object(ownership.entry);
    if (ownership !== undefined && !owned) throw new Error(`Unrecognized Coding Sessions ${kind} ownership metadata; review the local MCP configuration.`);
    if (servers[name] !== undefined) {
      // A release path may change, but an operator-edited entry is never overwritten.
      const expected = owned ? ownership.entry : wanted;
      if (expected === null || !isDeepStrictEqual(servers[name], expected)) {
        // Nothing to install: leave an operator's entry alone rather than blocking the launch.
        if (wanted === null) return;
        throw new Error(`${label} MCP name ${name} is already used by another configuration.`);
      }
      if (owned && isDeepStrictEqual(servers[name], wanted)) return;
    } else if (wanted === null) {
      if (owned) { delete next[ownershipKey]; changed = true; }
      return;
    }
    if (wanted === null) { delete servers[name]; delete next[ownershipKey]; }
    else { servers[name] = wanted; next[ownershipKey] = { version: 1, entry: wanted }; }
    changed = true;
  };
  reconcile(CONNECTOR, OWNERSHIP, entries.communicator, "communicator");
  reconcile(GATEWAY, GATEWAY_OWNERSHIP, entries.gateway, "connector");
  if (!changed) return;
  const temporary = join(dirname(file), `.mcp-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ ...next, mcpServers: servers }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Install the app-owned entries into ~/<parts...>/<fileName>; never into a repository. */
export function installUserMcpConfig(home: string, parts: string[], fileName: string, entries: { communicator: unknown; gateway: unknown | null }, label: string): void {
  reconcileMcpConfig(join(privateDirectory(home, parts, label), fileName), entries, label);
}

/** Private local scope has precedence over repository config; never write into the repository. */
export function installCommandCodeCommunicator(home: string, slug: string, paths: Paths = {}, connectors = false): void {
  if (slug && !/^[a-z0-9-]+$/.test(slug)) throw new Error("Command Code returned an unsupported project configuration name.");
  installUserMcpConfig(home, [".commandcode", "projects", ...(slug ? [slug] : [])], "mcp.json",
    { communicator: entry(paths), gateway: connectors ? gatewayEntry(paths) : null }, "Command Code");
}

/** Return only nonsecret invocation arguments; token values travel separately through spawn env. */
export async function providerCommunicatorArgs(provider: "claude" | "codex" | "command-code", cwd: string, options: Options = {}): Promise<string[]> {
  const server = entry(options);
  const gateway = options.connectors ? gatewayEntry(options) : null;
  if (provider === "claude") return ["--mcp-config", JSON.stringify({ mcpServers: { [CONNECTOR]: server, ...(gateway ? { [GATEWAY]: gateway } : {}) } })];
  if (provider === "codex") return [
    "-c", `mcp_servers.${CONNECTOR}={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},env_vars=["CS_COMMUNICATOR_TOKEN","CS_COMMUNICATOR_URL"]}`,
    ...(gateway ? ["-c", `mcp_servers.${GATEWAY}={command=${JSON.stringify(gateway.command)},args=${JSON.stringify(gateway.args)},env_vars=["CS_CONNECTOR_TOKEN","CS_CONNECTOR_URL"],tool_timeout_sec=130}`] : []),
  ];
  let slug: string;
  try {
    if (!options.commandCodeBin) throw new Error();
    const dependency = Bun.resolveSync("@sindresorhus/slugify", dirname(realpathSync(options.commandCodeBin)));
    const { default: slugify } = await import(dependency);
    slug = slugify(physicalProjectPath(cwd));
  } catch {
    throw new Error("Command Code communicator requires a supported npm installation with its slugify dependency. Reinstall or update Command Code.");
  }
  installCommandCodeCommunicator(options.home ?? homedir(), slug, options, !!options.connectors);
  return [];
}
