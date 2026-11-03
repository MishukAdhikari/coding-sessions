import { childEnvironment } from "./child-env";
/**
 * Branch and pull-request lookups for the Fresh Launch picker.
 *
 * Everything an operator types is matched against a strict shape before it reaches
 * `gh`, and every call passes an argv array — never a shell string. A pasted PR URL
 * is resolved to its head branch so the operator never has to know the branch name.
 */
const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export interface RepoRef { owner: string; repo: string; slug: string }

/** Accept `owner/repo`, a GitHub URL, or an SSH remote — reject everything else. */
export function parseRepoRef(input: string): RepoRef | null {
  const trimmed = String(input ?? "").trim().replace(/^git\+/, "");
  const m = trimmed.match(
    /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)?([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/,
  );
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo) || repo === "." || repo === "..") return null;
  return { owner, repo, slug: `${owner}/${repo}` };
}

export interface PullRef extends RepoRef { number: number }

/** A pull-request URL, or `owner/repo#123`, in the same field as everything else. */
export function parsePullRef(input: string): PullRef | null {
  const trimmed = String(input ?? "").trim();
  const url = trimmed.match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/);
  const short = trimmed.match(/^([^/\s]+)\/([^/\s#]+)#(\d+)$/);
  const m = url ?? short;
  if (!m) return null;
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/, "");
  const number = Number(m[3]);
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { owner, repo, slug: `${owner}/${repo}`, number };
}

export interface BranchList {
  branches: string[];
  defaultBranch: string | null;
  /** What the launcher would actually check out if the operator picks nothing. */
  suggested: string | null;
}

/** `dev` wins when it exists — it is this project's convention — then the repo default. */
export function suggestBranch(branches: readonly string[], defaultBranch: string | null): string | null {
  if (branches.includes("dev")) return "dev";
  if (defaultBranch && branches.includes(defaultBranch)) return defaultBranch;
  return defaultBranch ?? branches[0] ?? null;
}

/** `gh api .../branches` with a name filter prints one branch per line. */
export function parseBranchLines(raw: string, defaultBranch: string | null): BranchList {
  const branches = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (defaultBranch && !branches.includes(defaultBranch)) branches.unshift(defaultBranch);
  return { branches, defaultBranch, suggested: suggestBranch(branches, defaultBranch) };
}

export interface PullDetail {
  number: number;
  title: string;
  branch: string;
  repo: string;
  state: string;
  /** True when the PR comes from a fork, whose head branch is not in this repo. */
  crossRepo: boolean;
}

export function parsePullPayload(raw: string, ref: PullRef): PullDetail | null {
  try {
    const pr = JSON.parse(raw) as {
      number?: number; title?: string; headRefName?: string; state?: string;
      headRepositoryOwner?: { login?: string } | null; isCrossRepository?: boolean;
    };
    if (!pr.headRefName) return null;
    const headOwner = pr.headRepositoryOwner?.login ?? null;
    return {
      number: pr.number ?? ref.number,
      title: typeof pr.title === "string" ? pr.title.slice(0, 120) : "",
      branch: pr.headRefName,
      repo: ref.slug,
      state: typeof pr.state === "string" ? pr.state : "UNKNOWN",
      crossRepo: pr.isCrossRepository === true || (!!headOwner && headOwner.toLowerCase() !== ref.owner.toLowerCase()),
    };
  } catch {
    return null;
  }
}

type Run = (cmd: string[]) => Promise<{ code: number; out: string; err: string }>;

const defaultRun: Run = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: childEnvironment() });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out, err };
};

const ghBin = () => Bun.which("gh") ?? "/usr/bin/gh";

/** Branches for one repo, newest-committed first — that is the order gh returns. */
export async function fetchBranches(ref: RepoRef, run: Run = defaultRun): Promise<{ ok: true; data: BranchList } | { ok: false; error: string }> {
  const [list, meta] = await Promise.all([
    run([ghBin(), "api", `repos/${ref.slug}/branches?per_page=100`, "-q", ".[].name"]),
    run([ghBin(), "api", `repos/${ref.slug}`, "-q", ".default_branch"]),
  ]);
  if (list.code !== 0) return { ok: false, error: ghError(list.err, `Could not read branches for ${ref.slug}.`) };
  const defaultBranch = meta.code === 0 && meta.out.trim() ? meta.out.trim() : null;
  const data = parseBranchLines(list.out, defaultBranch);
  if (!data.branches.length) return { ok: false, error: `${ref.slug} has no branches the server can see.` };
  return { ok: true, data };
}

export async function fetchPull(ref: PullRef, run: Run = defaultRun): Promise<{ ok: true; data: PullDetail } | { ok: false; error: string }> {
  const { code, out, err } = await run([
    ghBin(), "pr", "view", String(ref.number), "--repo", ref.slug,
    "--json", "number,title,headRefName,state,headRepositoryOwner,isCrossRepository",
  ]);
  if (code !== 0) return { ok: false, error: ghError(err, `Could not read pull request #${ref.number}.`) };
  const parsed = parsePullPayload(out, ref);
  if (!parsed) return { ok: false, error: `Could not read pull request #${ref.number}.` };
  return { ok: true, data: parsed };
}

/** Surface gh's own reason when it is short and useful; never leak a wall of stderr. */
export function ghError(stderr: string, fallback: string): string {
  const line = stderr.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("Usage:"));
  if (!line) return fallback;
  if (/not found|Could not resolve/i.test(line)) return `${fallback} It may not exist, or gh may not have access.`;
  if (/gh auth login|authentication/i.test(line)) return "The server's GitHub CLI is not signed in.";
  return line.length <= 160 ? line : fallback;
}
