import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, statSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerCommunicatorArgs, installCommandCodeCommunicator, communicatorEnvironment } from "./communicator-config";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const home = () => { const dir = mkdtempSync(join(tmpdir(), "cs-config-")); roots.push(dir); return dir; };
const paths = { bunPath: "/opt/app's copy/bun", bridgePath: "/opt/app's copy/server/communicator-stdio.ts" };
test("Claude and Codex MCP arguments use inherited identity without credential literals or approval flags", async () => {
  const claude = await providerCommunicatorArgs("claude", "/srv/demo", paths);
  expect(claude[0]).toBe("--mcp-config");
  const entry = JSON.parse(claude[1]!).mcpServers.coding_sessions_communicator;
  expect(entry.command).toBe(paths.bunPath);
  expect(entry.env.CS_COMMUNICATOR_TOKEN).toBe("${CS_COMMUNICATOR_TOKEN}");
  const codex = await providerCommunicatorArgs("codex", "/srv/demo", paths);
  expect(codex[0]).toBe("-c");
  const parsed = Bun.TOML.parse(codex[1]!) as { mcp_servers: { coding_sessions_communicator: { env_vars: string[] } } };
  expect(parsed.mcp_servers.coding_sessions_communicator.env_vars).toEqual(["CS_COMMUNICATOR_TOKEN", "CS_COMMUNICATOR_URL"]);
  expect([...claude, ...codex].join(" ")).not.toContain("bypass");
  expect(communicatorEnvironment("private-token", 9121)).toEqual({ CS_COMMUNICATOR_TOKEN: "private-token", CS_COMMUNICATOR_URL: "http://127.0.0.1:9121/mcp/communicator" });
});
test("Command Code local configuration preserves other entries and stays credential-free across starts", () => {
  const dir = home(); const target = join(dir, ".commandcode/projects/srv-demo/mcp.json");
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, JSON.stringify({ custom: true, mcpServers: { other: { command: "other" } } }));
  installCommandCodeCommunicator(dir, "srv-demo", paths);
  const once = readFileSync(target, "utf8");
  installCommandCodeCommunicator(dir, "srv-demo", paths);
  expect(readFileSync(target, "utf8")).toBe(once);
  expect(JSON.parse(once)).toMatchObject({ custom: true, mcpServers: { other: { command: "other" } } });
  expect(JSON.parse(once).mcpServers.coding_sessions_communicator.env.CS_COMMUNICATOR_TOKEN).toBe("${CS_COMMUNICATOR_TOKEN}");
  expect(statSync(target).mode & 0o777).toBe(0o600);
});
test("malformed, symlinked and reserved-name conflicting config is left intact", () => {
  for (const contents of ["{bad", JSON.stringify({ mcpServers: [] }), JSON.stringify({ mcpServers: { coding_sessions_communicator: { command: "unrelated" } } })]) {
    const dir = home();const target=join(dir,".commandcode/projects/demo/mcp.json");mkdirSync(join(target,".."),{recursive:true});writeFileSync(target,contents);
    expect(()=>installCommandCodeCommunicator(dir,"demo",paths)).toThrow();expect(readFileSync(target,"utf8")).toBe(contents);
  }
  const dir=home(); const outside=join(dir,"outside");writeFileSync(outside,"{}");mkdirSync(join(dir,".commandcode/projects/demo"),{recursive:true});symlinkSync(outside,join(dir,".commandcode/projects/demo/mcp.json"));
  expect(()=>installCommandCodeCommunicator(dir,"demo",paths)).toThrow();expect(readFileSync(outside,"utf8")).toBe("{}");
});

test("an unsupported Command Code installation fails before touching local configuration", async () => {
  const dir = home();
  await expect(providerCommunicatorArgs("command-code", "/srv/ÜberAPI/xCloud", { home: dir, commandCodeBin: "/definitely/missing/cmd" })).rejects.toThrow("supported npm installation");
});

test("Command Code config follows physical directories through existing and future symlinked projects", async () => {
  const dir = home();
  const binary = join(dir, "cli/cmd");
  const dependency = join(dir, "cli/node_modules/@sindresorhus/slugify");
  mkdirSync(dependency, { recursive: true });
  writeFileSync(binary, "");
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "@sindresorhus/slugify", type: "module", main: "index.js" }));
  writeFileSync(join(dependency, "index.js"), "export default value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');");
  const physical = join(dir, "physical");
  mkdirSync(physical);
  const alias = join(dir, "alias");
  symlinkSync(physical, alias);
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const suffix of ["", "future/project"]) {
    await providerCommunicatorArgs("command-code", join(alias, suffix), { home: dir, commandCodeBin: binary, ...paths });
    const target = join(dir, ".commandcode/projects", slug(join(realpathSync(physical), suffix)), "mcp.json");
    expect(JSON.parse(readFileSync(target, "utf8")).mcpServers.coding_sessions_communicator.command).toBe(paths.bunPath);
    expect(existsSync(join(dir, ".commandcode/projects", slug(join(alias, suffix)), "mcp.json"))).toBe(false);
  }
});
test("an installer upgrade updates only an untouched app-owned Command Code entry", () => {
  const dir = home(); const file = join(dir, ".commandcode/projects/demo/mcp.json");
  installCommandCodeCommunicator(dir, "demo", paths);
  const original = JSON.parse(readFileSync(file, "utf8"));
  original.mcpServers.other = { command: "other" };
  writeFileSync(file, JSON.stringify(original));
  const upgraded = { bunPath: "/opt/releases/two/bun", bridgePath: "/opt/releases/two/server/communicator-stdio.ts" };
  installCommandCodeCommunicator(dir, "demo", upgraded);
  const config = JSON.parse(readFileSync(file, "utf8"));
  expect(config.mcpServers.coding_sessions_communicator.command).toBe(upgraded.bunPath);
  expect(config.mcpServers.other).toEqual({ command: "other" });
  config.mcpServers.coding_sessions_communicator.command = "/user/modified";
  writeFileSync(file, JSON.stringify(config));
  const edited = readFileSync(file, "utf8");
  expect(() => installCommandCodeCommunicator(dir, "demo", paths)).toThrow("already used");
  expect(readFileSync(file, "utf8")).toBe(edited);
});
