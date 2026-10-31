import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const CONNECTOR = "coding_sessions_communicator";
const OWNERSHIP = "_codingSessionsCommunicator";
interface Paths { bunPath?: string; bridgePath?: string }
interface Options extends Paths { home?: string; commandCodeBin?: string }
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
function entry(paths: Paths) {
  return { type: "stdio", command: paths.bunPath ?? process.execPath,
    args: [paths.bridgePath ?? fileURLToPath(new URL("./communicator-stdio.ts", import.meta.url))],
    env: { CS_COMMUNICATOR_TOKEN: "${CS_COMMUNICATOR_TOKEN}", CS_COMMUNICATOR_URL: "${CS_COMMUNICATOR_URL}" } };
}
export function communicatorEnvironment(token: string, port: number): Record<string, string> {
  return { CS_COMMUNICATOR_TOKEN: token, CS_COMMUNICATOR_URL: `http://127.0.0.1:${port}/mcp/communicator` };
}

/** Private local scope has precedence over repository config; never write into the repository. */
export function installCommandCodeCommunicator(home: string, slug: string, paths: Paths = {}): void {
  if (slug && !/^[a-z0-9-]+$/.test(slug)) throw new Error("Command Code returned an unsupported project configuration name.");
  let directory = home;
  for (const part of [".commandcode", "projects", ...(slug ? [slug] : [])]) {
    directory = join(directory, part);
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Command Code configuration directories must not be symlinks.");
  }
  const file = join(directory, "mcp.json");
  let config: Record<string, unknown> = {};
  try {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Command Code MCP configuration must be a regular JSON file smaller than 1 MiB.");
      const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
      if (!object(parsed) || (parsed.mcpServers !== undefined && !object(parsed.mcpServers))) throw new Error("Command Code MCP configuration must contain an object.");
      config = parsed;
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot safely update Command Code MCP configuration; repair its JSON, symlink, or permissions first.");
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  const wanted = entry(paths);
  const ownership = config[OWNERSHIP];
  const owned = object(ownership) && ownership.version === 1 && object(ownership.entry);
  if (ownership !== undefined && !owned) throw new Error("Unrecognized Coding Sessions communicator ownership metadata; review the local MCP configuration.");
  if (servers[CONNECTOR] !== undefined) {
    // A release path may change, but an operator-edited entry is never overwritten.
    const expected = owned ? ownership.entry : wanted;
    if (!isDeepStrictEqual(servers[CONNECTOR], expected)) throw new Error(`Command Code MCP name ${CONNECTOR} is already used by another configuration.`);
    if (owned && isDeepStrictEqual(servers[CONNECTOR], wanted)) return;
  }
  const temporary = join(directory, `.mcp-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify({ ...config, mcpServers: { ...servers, [CONNECTOR]: wanted }, [OWNERSHIP]: { version: 1, entry: wanted } }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/** Return only nonsecret invocation arguments; token values travel separately through spawn env. */
export async function providerCommunicatorArgs(provider: "claude" | "codex" | "command-code", cwd: string, options: Options = {}): Promise<string[]> {
  const server = entry(options);
  if (provider === "claude") return ["--mcp-config", JSON.stringify({ mcpServers: { [CONNECTOR]: server } })];
  if (provider === "codex") return ["-c", `mcp_servers.${CONNECTOR}={command=${JSON.stringify(server.command)},args=${JSON.stringify(server.args)},env_vars=["CS_COMMUNICATOR_TOKEN","CS_COMMUNICATOR_URL"]}`];
  let slug: string;
  try {
    if (!options.commandCodeBin) throw new Error();
    const dependency = Bun.resolveSync("@sindresorhus/slugify", dirname(realpathSync(options.commandCodeBin)));
    const { default: slugify } = await import(dependency);
    slug = slugify(physicalProjectPath(cwd));
  } catch {
    throw new Error("Command Code communicator requires a supported npm installation with its slugify dependency. Reinstall or update Command Code.");
  }
  installCommandCodeCommunicator(options.home ?? homedir(), slug, options);
  return [];
}
