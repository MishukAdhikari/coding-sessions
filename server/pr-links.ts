/**
 * GitHub pull request links a session's agent has printed, for its card.
 *
 * Agents open PRs with `gh pr create` and the URL lands in their own transcript (Claude
 * Code's project JSONL, Codex's rollout), so the card can show them without asking
 * GitHub. Each transcript is read once from its last few MiB, then only the bytes
 * written since the previous poll. Links come back newest first: what was printed last
 * is usually the PR the session is working on.
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface PrLink { url: string; repo: string; number: number }

// owner/repo as GitHub allows them, then /pull/<n>. A JSON-escaped slash (\/) is accepted too.
const PR_RE = /https:(?:\/|\\\/){2}github\.com(?:\/|\\\/)([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?:\/|\\\/)([A-Za-z0-9._-]{1,100})(?:\/|\\\/)pull(?:\/|\\\/)(\d{1,7})(?!\d)/g;

/** PR links in `text`, in order of their last appearance (earliest first). Pure. */
export function extractPrLinks(text: string): PrLink[] {
  const seen = new Map<string, PrLink>();
  for (const m of text.matchAll(PR_RE)) {
    const repo = `${m[1]}/${m[2]}`.replace(/\.git$/, "");
    const number = Number(m[3]);
    const url = `https://github.com/${repo}/pull/${number}`;
    seen.delete(url); // a later mention moves it to the end
    seen.set(url, { url, repo, number });
  }
  return [...seen.values()];
}

// What an agent writes (a tool call's input: code, a file, a PR body) is not a PR it worked on.
const AUTHORED = new Set(["tool_use", "function_call", "custom_tool_call", "server_tool_use"]);
// Claude Code also keeps a tool's full result under toolUseResult (a written file's whole content, an
// edit's patch), and wireToolInputs repeats a tool call's input. What the agent saw is already in the
// message's tool_result, so those copies are skipped.
const SKIPPED_KEYS = new Set(["toolUseResult", "wireToolInputs"]);

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 40) return;
  if (typeof value === "string") { out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectStrings(item, out, depth + 1); return; }
  if (value && typeof value === "object") {
    if (AUTHORED.has(String((value as { type?: unknown }).type))) return;
    for (const [key, item] of Object.entries(value)) if (!SKIPPED_KEYS.has(key)) collectStrings(item, out, depth + 1);
  }
}

/**
 * PR links in a transcript chunk of JSON lines: tool output, the agent's own words and the
 * user's prompts count; tool-call inputs do not. A line that isn't JSON is read as text.
 */
export function extractTranscriptPrLinks(text: string): PrLink[] {
  const parts: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("/pull/") && !line.includes("\\/pull\\/")) continue;
    try { collectStrings(JSON.parse(line), parts); } catch { parts.push(line); }
  }
  return extractPrLinks(parts.join("\n"));
}

/** Merge newly found links into what a transcript showed before; newest first, at most `max`. */
export function mergePrLinks(previous: PrLink[], found: PrLink[], max: number): PrLink[] {
  const urls = new Set(found.map(link => link.url));
  return [...found.slice().reverse(), ...previous.filter(link => !urls.has(link.url))].slice(0, max);
}

const FIRST_READ_BYTES = 8 * 1024 * 1024;

interface Seen { offset: number; links: PrLink[] }

export function createPrLinkTracker(options: { max?: number; firstReadBytes?: number } = {}) {
  const max = options.max ?? 3;
  const firstRead = options.firstReadBytes ?? FIRST_READ_BYTES;
  const byPath = new Map<string, Seen>();

  function read(path: string, from: number, to: number): Buffer {
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(to - from);
      let done = 0;
      while (done < buffer.length) {
        const n = readSync(fd, buffer, done, buffer.length - done, from + done);
        if (n <= 0) break;
        done += n;
      }
      return buffer.subarray(0, done);
    } finally {
      closeSync(fd);
    }
  }

  /** The PR links in the transcript at `path`; [] when it can't be read. */
  function linksFor(path: string | null): PrLink[] {
    if (!path) return [];
    let size: number;
    try { size = statSync(path).size; } catch { byPath.delete(path); return []; }
    let seen = byPath.get(path);
    // A transcript that shrank was replaced: start again.
    if (seen && size < seen.offset) seen = undefined;
    if (seen && size === seen.offset) return seen.links;
    const from = seen ? seen.offset : Math.max(0, size - firstRead);
    let chunk: Buffer;
    try { chunk = read(path, from, size); } catch { return seen?.links ?? []; }
    // Whole lines only, so each one parses as the JSON it is: a first read that starts mid-file
    // skips its partial first line, and an unfinished last line waits for the next poll.
    const start = !seen && from > 0 ? chunk.indexOf(10) + 1 : 0;
    const end = chunk.lastIndexOf(10) + 1;
    if (start <= 0 && from > 0 && !seen) { byPath.set(path, { offset: size, links: [] }); return []; }
    const links = end > start
      ? mergePrLinks(seen?.links ?? [], extractTranscriptPrLinks(chunk.subarray(start, end).toString("utf8")), max)
      : seen?.links ?? [];
    byPath.set(path, { offset: from + Math.max(end, start), links });
    return links;
  }

  /** Forget transcripts no live session uses any more. */
  function keepOnly(paths: Set<string>): void {
    for (const path of byPath.keys()) if (!paths.has(path)) byPath.delete(path);
  }

  return { linksFor, keepOnly };
}
