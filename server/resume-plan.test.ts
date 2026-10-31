import { test, expect } from "bun:test";
import { planResume } from "./sessions";

// planResume decides the `claude` resume flag from what survives on disk:
//   exactExists = the stored conversation's transcript is still there
//   anyExists   = the project folder holds at least one conversation

test("exact transcript present → resume that exact conversation", () => {
  expect(planResume(true, true)).toEqual({ arg: "--resume" });
});

test("exact gone but folder has other conversations → continue the latest", () => {
  expect(planResume(false, true)).toEqual({ arg: "--continue" });
});

test("nothing left in the folder → blocked, nothing to resume", () => {
  expect(planResume(false, false)).toEqual({ blocked: true });
});

test("exactExists implies anyExists, and still resumes the exact one", () => {
  // A caller that computes anyExists as `exactExists || projectHasAnyTranscript`
  // will always pass anyExists=true when exactExists=true; --resume must win.
  expect(planResume(true, true)).toEqual({ arg: "--resume" });
});
