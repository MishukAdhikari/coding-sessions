import { test, expect } from "bun:test";
import {
  fetchBranches, fetchPull, ghError, parseBranchLines, parsePullPayload,
  parsePullRef, parseRepoRef, suggestBranch,
} from "./repo-refs";

const ok = (out: string) => async () => ({ code: 0, out, err: "" });
const fail = (err: string) => async () => ({ code: 1, out: "", err });

/* ---------- repo refs ---------- */

test("owner/repo, URLs and SSH remotes all resolve to the same slug", () => {
  for (const input of [
    "ExampleOwner/coding-sessions",
    "https://github.com/ExampleOwner/coding-sessions",
    "https://www.github.com/ExampleOwner/coding-sessions/",
    "https://github.com/ExampleOwner/coding-sessions.git",
    "git@github.com:ExampleOwner/coding-sessions.git",
    "  ExampleOwner/coding-sessions  ",
  ]) {
    expect(parseRepoRef(input)?.slug).toBe("ExampleOwner/coding-sessions");
  }
});

test("anything that isn't a repo reference is refused before it reaches gh", () => {
  for (const bad of ["", "not-a-repo", "a/b/c", "../../etc/passwd", "owner/", "/repo", "own er/repo", "a/b; rm -rf /", "-flag/repo"]) {
    expect(parseRepoRef(bad)).toBeNull();
  }
});

/* ---------- pull refs ---------- */

test("a pasted pull-request URL yields owner, repo and number", () => {
  const ref = parsePullRef("https://github.com/xCloudDev/xCloud/pull/5626");
  expect(ref).toEqual({ owner: "xCloudDev", repo: "xCloud", slug: "xCloudDev/xCloud", number: 5626 });
});

test("PR URLs survive the trailing junk GitHub adds", () => {
  expect(parsePullRef("https://github.com/o/r/pull/12/files")?.number).toBe(12);
  expect(parsePullRef("https://github.com/o/r/pull/12?diff=split")?.number).toBe(12);
  expect(parsePullRef("https://github.com/o/r/pull/12#issuecomment-9")?.number).toBe(12);
});

test("the owner/repo#123 shorthand is a pull request, not a branch", () => {
  expect(parsePullRef("xCloudDev/xCloud#5626")?.number).toBe(5626);
  expect(parsePullRef("xCloudDev/xCloud#dev")).toBeNull(); // that's a branch ref
});

test("non-pull inputs are refused", () => {
  for (const bad of ["https://github.com/o/r", "https://github.com/o/r/pull/abc", "https://github.com/o/r/pull/0", "o/r#-1", ""]) {
    expect(parsePullRef(bad)).toBeNull();
  }
});

/* ---------- branch selection ---------- */

test("dev wins when it exists, because that is this project's convention", () => {
  expect(suggestBranch(["main", "dev", "feat/x"], "main")).toBe("dev");
});

test("without dev, the repo default wins", () => {
  expect(suggestBranch(["main", "feat/x"], "main")).toBe("main");
});

test("with neither, fall back to something real rather than nothing", () => {
  expect(suggestBranch(["release"], null)).toBe("release");
  expect(suggestBranch([], null)).toBeNull();
});

test("the default branch is included even if the listing missed it", () => {
  const list = parseBranchLines("feat/a\nfeat/b\n", "main");
  expect(list.branches).toEqual(["main", "feat/a", "feat/b"]);
  expect(list.suggested).toBe("main");
});

test("blank lines in gh output don't become phantom branches", () => {
  expect(parseBranchLines("main\n\n  \ndev\n", "main").branches).toEqual(["main", "dev"]);
});

/* ---------- fetching ---------- */

test("fetchBranches asks gh for the right repo and never builds a shell string", async () => {
  const calls: string[][] = [];
  const run = async (cmd: string[]) => {
    calls.push(cmd);
    return { code: 0, out: cmd.includes("-q") && cmd.at(-1) === ".default_branch" ? "main" : "main\ndev", err: "" };
  };
  const result = await fetchBranches(parseRepoRef("o/r")!, run);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.suggested).toBe("dev");
  expect(calls.every((c) => Array.isArray(c) && c.length > 1)).toBe(true);
  expect(calls[0]).toContain("repos/o/r/branches?per_page=100");
});

test("a repo with no visible branches is an error, not an empty picker", async () => {
  const result = await fetchBranches(parseRepoRef("o/r")!, ok(""));
  expect(result.ok).toBe(false);
});

test("fetchPull returns the head branch a fresh workspace should check out", async () => {
  const payload = JSON.stringify({
    number: 5626, title: "Fix the monitoring card", headRefName: "fix/site-disk-monitoring",
    state: "OPEN", headRepositoryOwner: { login: "xCloudDev" }, isCrossRepository: false,
  });
  const result = await fetchPull(parsePullRef("xCloudDev/xCloud#5626")!, ok(payload));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.branch).toBe("fix/site-disk-monitoring");
  expect(result.data.crossRepo).toBe(false);
  expect(result.data.title).toBe("Fix the monitoring card");
});

test("a fork PR is flagged, because its branch is not in the target repo", async () => {
  const payload = JSON.stringify({
    number: 7, title: "Drive-by", headRefName: "patch-1", state: "OPEN",
    headRepositoryOwner: { login: "someone-else" }, isCrossRepository: true,
  });
  const result = await fetchPull(parsePullRef("o/r#7")!, ok(payload));
  expect(result.ok && result.data.crossRepo).toBe(true);
});

test("gh failures become one readable line, not a wall of stderr", async () => {
  const result = await fetchPull(parsePullRef("o/r#7")!, fail("GraphQL: Could not resolve to a Repository"));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toContain("It may not exist");
});

test("a signed-out gh says so plainly", () => {
  expect(ghError("gh auth login required", "fallback")).toBe("The server's GitHub CLI is not signed in.");
});

test("unparseable gh output fails rather than inventing a branch", async () => {
  const result = await fetchPull(parsePullRef("o/r#7")!, ok("not json"));
  expect(result.ok).toBe(false);
});

test("a PR payload without a head branch is refused", () => {
  expect(parsePullPayload(JSON.stringify({ number: 1 }), parsePullRef("o/r#1")!)).toBeNull();
});
