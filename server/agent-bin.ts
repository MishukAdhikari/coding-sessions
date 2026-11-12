import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where an agent's CLI is: on PATH, else where deploy/install-provider-clis puts it
 * (~/.local/bin), which a service's PATH may lack. Claude and the presets already
 * fall back this way; Codex and Command Code must too, or an agent installed from
 * the app reads as "not installed" while its neighbours in the same folder work.
 */
export function agentBin(
  name: string,
  home: string = homedir(),
  which: (name: string) => string | null = Bun.which,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const found = which(name);
  if (found) return found;
  const local = join(home, ".local", "bin", name);
  return exists(local) ? local : null;
}
