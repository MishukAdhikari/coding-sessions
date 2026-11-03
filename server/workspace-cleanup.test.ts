import { expect, test } from "bun:test";
import { agentStatePaths, isInsideWorkspace } from "./workspace-cleanup";

const ws = "/home/example/workspaces/n-demo";

test("processes inside a workspace are found, even after the folder was removed", () => {
  expect(isInsideWorkspace(ws, ws)).toBe(true);
  expect(isInsideWorkspace(ws, `${ws}/node_modules/.bin`)).toBe(true);
  expect(isInsideWorkspace(ws, `${ws} (deleted)`)).toBe(true);
  expect(isInsideWorkspace(ws, `${ws}/sub (deleted)`)).toBe(true);
});

test("neighbouring folders and unknown cwds are left alone", () => {
  expect(isInsideWorkspace(ws, "/home/example/workspaces/n-demo-2")).toBe(false);
  expect(isInsideWorkspace(ws, "/home/example/workspaces")).toBe(false);
  expect(isInsideWorkspace(ws, null)).toBe(false);
});

test("agent state for a workspace is named the way each agent names it", () => {
  expect(agentStatePaths(ws, "/home/example")).toEqual([
    "/home/example/.claude/projects/-home-example-workspaces-n-demo",
    "/home/example/.cache/claude-cli-nodejs/-home-example-workspaces-n-demo",
    "/home/example/.commandcode/projects/home-example-workspaces-n-demo",
  ]);
});
