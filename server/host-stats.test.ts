import { test, expect } from "bun:test";
import { parseCpuSample, cpuPercent, parseMem, hostStats } from "./host-stats";

const STAT = [
  "cpu  100 10 40 800 50 0 0 0 0 0",
  "cpu0 50 5 20 400 25 0 0 0 0 0",
  "intr 12345",
].join("\n");

test("parseCpuSample counts iowait as idle", () => {
  expect(parseCpuSample(STAT)).toEqual({ busy: 150, total: 1000 });
});

test("parseCpuSample rejects junk", () => {
  expect(parseCpuSample("intr 1\nctxt 2")).toBeNull();
  expect(parseCpuSample("cpu  x y")).toBeNull();
});

test("cpuPercent measures the delta between samples, not since boot", () => {
  const prev = { busy: 150, total: 1000 };
  expect(cpuPercent(prev, { busy: 175, total: 1100 })).toBe(25);
  expect(cpuPercent(prev, { busy: 150, total: 1100 })).toBe(0);
});

test("cpuPercent falls back to the since-boot average on the first read", () => {
  expect(cpuPercent(null, { busy: 150, total: 1000 })).toBe(15);
});

test("cpuPercent survives a counter reset", () => {
  expect(cpuPercent({ busy: 150, total: 1000 }, { busy: 10, total: 20 })).toBe(0);
});

test("parseMem reads MemAvailable, not MemFree", () => {
  const meminfo = "MemTotal:        8000000 kB\nMemFree:          200000 kB\nMemAvailable:    5000000 kB\n";
  expect(parseMem(meminfo)).toEqual({ totalKb: 8000000, availableKb: 5000000 });
});

test("parseMem returns null when a field is missing", () => {
  expect(parseMem("MemTotal:        8000000 kB\n")).toBeNull();
});

test("parseMem never reports more available than total", () => {
  expect(parseMem("MemTotal: 100 kB\nMemAvailable: 500 kB\n")?.availableKb).toBe(100);
});

test("hostStats reports percentages in range on this host", () => {
  const s = hostStats();
  expect(s).not.toBeNull();
  for (const pct of [s!.cpu, s!.mem, s!.disk]) {
    expect(pct).toBeGreaterThanOrEqual(0);
    expect(pct).toBeLessThanOrEqual(100);
  }
  expect(s!.memTotalGb).toBeGreaterThan(0);
  expect(s!.memUsedGb).toBeLessThanOrEqual(s!.memTotalGb);
  expect(s!.diskFreeGb).toBeGreaterThanOrEqual(0);
});
