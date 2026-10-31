import { readCsSetting } from "./environment";

type Environment = Record<string, string | undefined>;

export interface ConnectorIdentity { account: string; role: string | null }
export interface ConnectorPreset {
  id: string;
  label: string;
  url: string;
  /** Tools an operator may grant in this release: read-only by the upstream source, with narrow arguments. */
  grantable: readonly string[];
  /** Pre-ticked when the operator chooses "Use recommended". Still an explicit operator action. */
  recommended: readonly string[];
  /** Only what the upstream itself reports. Never guessed from the credential. */
  identity(instructions: string): ConnectorIdentity | null;
}

// Excluded although annotated read-only upstream: file_get (arbitrary files), site_http
// (arbitrary requests), inertia_props and callback_capture (act as members), and the
// token/key listings. Mutations wait for resource ownership and leases.
const XCDEV_READ = [
  "qa_guide", "lab_list", "env_status", "qa_preflight", "jobs_list", "job_wait", "task_log",
  "archives_list", "fixture_list", "wl_status", "server_health",
] as const;

export const PRESETS: Record<string, ConnectorPreset> = {
  xcdev: {
    id: "xcdev",
    label: "xcdev lab",
    url: "https://xcdev.tmp1.dev/mcp",
    grantable: XCDEV_READ,
    recommended: ["qa_guide", "lab_list", "env_status", "jobs_list", "job_wait", "task_log"],
    identity(instructions) {
      const match = /^You are connected to the xcdev lab\b[^\n]*? as ([^\n()]{1,80}?) \(([a-z_-]{1,32})\)\./m.exec(instructions);
      return match ? { account: match[1]!.trim(), role: match[2]! } : null;
    },
  },
};

/** HTTPS only, or loopback HTTP for a local mock. No credentials, query or fragment in the URL. */
export function validateEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Connector URL is not a valid URL."); }
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback))) throw new Error("Connector URL must use HTTPS (HTTP is allowed only on loopback).");
  if (url.username || url.password || url.search || url.hash) throw new Error("Connector URL must not contain credentials, a query or a fragment.");
  return url;
}

/** The operator may point a preset at another deployment (or a mock) through the service environment only. */
export function presetEndpoint(preset: ConnectorPreset, env: Environment = process.env): URL {
  const override = readCsSetting(env, `CS_CONNECTOR_${preset.id.toUpperCase()}_URL` as `CS_${string}`);
  return validateEndpoint(override || preset.url);
}
