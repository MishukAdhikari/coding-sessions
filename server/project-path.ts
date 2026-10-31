import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { normalize } from "node:path";

/**
 * Validate a candidate project folder.
 *
 * Projects exist so that sessions can be started inside them, so "the server can
 * write here" is part of being a valid project rather than a detail to discover
 * later from inside a session — where the failure is a bare write error with no
 * visible connection to the project that was added.
 *
 * Extracted from the route handler so the rules are testable without booting the
 * HTTP server; the handler maps the result onto a response and owns nothing else.
 */

export type ProjectPathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/** `/foo/` and `/foo` are the same folder, but `projects.path` is UNIQUE on the
 *  exact string — without this they become two rows for one directory. */
const stripTrailingSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function validateProjectPath(rawPath: unknown, create: boolean): ProjectPathResult {
  const p = stripTrailingSlash(typeof rawPath === "string" ? normalize(rawPath) : "");
  if (!p.startsWith("/")) {
    return { ok: false, error: "Path must be an absolute path starting with /." };
  }

  if (!existsSync(p)) {
    if (!create) {
      return { ok: false, error: "That folder doesn’t exist. Tick “Create the folder” to make it." };
    }
    try {
      mkdirSync(p, { recursive: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") {
        return {
          ok: false,
          error: `The server can’t create ${p} — it doesn’t have write access there. Create the folder yourself first (e.g. in xCloud or with sudo), then add it here without ticking “Create the folder”.`,
        };
      }
      return { ok: false, error: `Couldn’t create that folder: ${(e as Error).message}` };
    }
  }

  if (!statSync(p).isDirectory()) {
    return { ok: false, error: "That path exists but is not a directory." };
  }

  // Advisory pre-flight, not a security gate: this tells a human who is about to
  // fix permissions what is wrong. The usual TOCTOU objection to access() does
  // not apply — nothing here opens the path afterwards.
  try {
    accessSync(p, constants.W_OK);
  } catch {
    return {
      ok: false,
      error: `The server can’t write to ${p} — sessions started there would fail to create files. Give the account running this app write access to it (e.g. chown), then add it again.`,
    };
  }

  return { ok: true, path: p };
}
