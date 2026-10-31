import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const code = source.slice(source.indexOf('  function renderBranchButton('), source.indexOf('  async function pickRepo('));
function render(branches, chosen, loading = false) {
  const attrs = new Map();
  const button = { dataset: { loading: loading ? "1" : "" }, disabled: false, innerHTML: "", setAttribute: (k,v) => attrs.set(k,v), removeAttribute: k => attrs.delete(k) };
  const results = { hidden: false };
  const state = { branchList: branches, chosenBranch: chosen, $: id => id === "btn-branch" ? button : results,
    workspaceIcons: { "git-branch": "", "chevron-down": "chevron" }, escapeHtml: s => s };
  runInNewContext(code + '\nrenderBranchButton(chosenBranch);', state);
  return { button, results, attrs };
}
test("single selected branch is informational, not an empty interaction", () => {
  const h = render(["main"], "main");
  expect(h.button.disabled).toBe(true);
  expect(h.button.innerHTML).toContain("Only branch");
  expect(h.attrs.has("aria-haspopup")).toBe(false);
  expect(h.results.hidden).toBe(true);
});
test("alternative branches remain selectable including a missing PR branch", () => {
  expect(render(["main","dev"], "main").button.disabled).toBe(false);
  expect(render(["main"], "fork-branch").button.disabled).toBe(false);
  expect(render(["main","dev"], "main").attrs.get("aria-haspopup")).toBe("listbox");
});
test("loading and failed branch requests do not open an empty menu", () => {
  expect(render(["main","dev"], "main", true).button.disabled).toBe(true);
  expect(render([], "main").button.disabled).toBe(true);
});
