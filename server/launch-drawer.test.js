import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const handler = source.slice(source.indexOf('  $("btn-new").addEventListener'), source.indexOf('  /* ---------- repo & branch picker'));
function harness(repository = "") {
  const elements = new Map();
  const requests = [];
  const state = { projects: [], selectedProject: null, FRESH_DEFAULT: "fresh", defaultRepository: () => repository, showSharedFolders: false,
    chosenRepo: null, chosenBranch: null, branchList: [], branchToken: 0, launchDrawerRequest: 0,
    openSheetEl: null, reposLoading: false, allRepos: [], renders: 0, opens: 0,
    $: id => {
      if (!elements.has(id)) elements.set(id, { value: "", hidden: false, textContent: "", addEventListener: (_, fn) => { state.click = fn; } });
      return elements.get(id);
    },
    api: path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
    renderPicker: () => { state.renders++; }, updateProviderAvailability() {}, updateNamePreview() {}, renderRepoResults() {},
    launchProviderInputs: () => [], loadPrefix: () => Promise.resolve(), requestAnimationFrame: fn => fn(),
    openSheet: id => { state.openSheetEl = { id }; state.opens++; },
  };
  runInNewContext(handler, state);
  return { state, requests, elements };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("drawer opens before projects respond and late data preserves user input", async () => {
  const h = harness(); h.state.click();
  expect(h.state.openSheetEl.id).toBe("sheet-new");
  expect(h.requests.map(r => r.path)).toEqual(["/api/projects", "/api/repos"]);
  h.elements.get("input-name").value = "my-work";
  h.state.selectedProject = "chosen";
  h.requests[0].resolve({ projects: [{ id: 1 }] }); await flush();
  expect(h.state.projects).toEqual([{ id: 1 }]);
  expect(h.elements.get("input-name").value).toBe("my-work");
  expect(h.state.selectedProject).toBe("chosen");
});
test("closing or reopening ignores old project and repository responses", async () => {
  const h = harness(); h.state.click(); h.state.openSheetEl = null;
  h.requests[0].resolve({ projects: [{ id: "closed" }] }); await flush();
  expect(h.state.projects).toEqual([]);
  h.state.click(); h.state.click();
  h.requests[2].resolve({ projects: [{ id: "stale" }] });
  h.requests[3].resolve({ repos: ["stale"] }); await flush();
  expect(h.state.projects).toEqual([]); expect(h.state.allRepos).toEqual([]);
  expect(h.state.opens).toBe(3);
});
test("failed project loading leaves the drawer usable with an explanation", async () => {
  const h = harness(); h.state.click(); h.requests[0].reject(Error("offline")); await flush();
  expect(h.state.openSheetEl.id).toBe("sheet-new");
  expect(h.elements.get("project-load-status").textContent).toContain("Fresh workspaces are still available");
});

test("without a configured default the drawer immediately exposes shared folders and repos", () => {
  const h = harness(); h.state.click();
  expect(h.state.selectedProject).toBeNull();
  expect(h.state.showSharedFolders).toBe(true);
});
test("a configured default keeps the fresh workspace shortcut", () => {
  const h = harness("example/project"); h.state.click();
  expect(h.state.selectedProject).toBe("fresh");
  expect(h.state.showSharedFolders).toBe(false);
});
