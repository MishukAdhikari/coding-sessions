/**
 * Pre-accept Claude Code's folder-trust dialog for a workspace path.
 * Run right before `exec claude` in a Fresh Launch — without this, claude
 * blocks on "Is this a project you trust?" inside the detached screen forever.
 * Usage: bun trust.ts ~/workspaces/<name>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const WORKSPACES_DIR = join(homedir(), "workspaces");

const path = process.argv[2];
if (!path?.startsWith(WORKSPACES_DIR + "/")) {
  console.error("refusing to trust non-workspace path:", path);
  process.exit(1);
}

const file = join(homedir(), ".claude.json");
let config: any = {};
try { config = JSON.parse(readFileSync(file, "utf8")); } catch {}
config.projects ??= {};
config.projects[path] = { ...(config.projects[path] ?? {}), hasTrustDialogAccepted: true };
writeFileSync(file, JSON.stringify(config, null, 2));
