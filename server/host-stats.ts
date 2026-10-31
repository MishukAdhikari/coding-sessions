/**
 * Host pressure — the CPU, memory and disk headroom of the box the Sessions run on.
 *
 * Read straight from /proc so the numbers match what `top` and `free` report; the
 * node:os fallback keeps local (macOS) development honest rather than empty. Disk
 * uses the same "available" figure the launch guard checks before a Fresh Launch,
 * so the strip in the top bar warns before a launch is refused.
 */
import { readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem } from "node:os";

export interface HostStats {
  cpu: number;        // 0-100, busy share since the previous sample
  mem: number;        // 0-100, used share of RAM
  memUsedGb: number;
  memTotalGb: number;
  disk: number;       // 0-100, used share of /
  diskFreeGb: number;
}

export interface CpuSample { busy: number; total: number }

/** First line of /proc/stat: cpu user nice system idle iowait irq softirq steal … */
export function parseCpuSample(procStat: string): CpuSample | null {
  const line = procStat.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  if (n.length < 4 || n.some((v) => !Number.isFinite(v))) return null;
  const total = n.reduce((a, b) => a + b, 0);
  const idle = (n[3] ?? 0) + (n[4] ?? 0); // idle + iowait
  return { busy: total - idle, total };
}

/** Busy share between two samples. Falls back to the since-boot average on the first read. */
export function cpuPercent(prev: CpuSample | null, now: CpuSample): number {
  const totalDelta = prev ? now.total - prev.total : now.total;
  const busyDelta = prev ? now.busy - prev.busy : now.busy;
  if (totalDelta <= 0 || busyDelta < 0) return 0;
  return clampPct((busyDelta / totalDelta) * 100);
}

/** MemAvailable, not MemFree — page cache is free memory in every sense that matters. */
export function parseMem(procMeminfo: string): { totalKb: number; availableKb: number } | null {
  const field = (key: string) => {
    const m = procMeminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const totalKb = field("MemTotal");
  const availableKb = field("MemAvailable");
  if (!totalKb || availableKb === null || totalKb <= 0) return null;
  return { totalKb, availableKb: Math.min(availableKb, totalKb) };
}

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
const read = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

let lastCpu: CpuSample | null = null;

function cpuNow(): number {
  const stat = read("/proc/stat");
  const sample = stat ? parseCpuSample(stat) : null;
  if (!sample) {
    // No /proc (macOS dev): load average per core is the closest honest stand-in.
    const cores = cpus().length || 1;
    return clampPct(((loadavg()[0] ?? 0) / cores) * 100);
  }
  const pct = cpuPercent(lastCpu, sample);
  lastCpu = sample;
  return pct;
}

function memNow(): { pct: number; usedGb: number; totalGb: number } {
  const meminfo = read("/proc/meminfo");
  const parsed = meminfo ? parseMem(meminfo) : null;
  const totalBytes = parsed ? parsed.totalKb * 1024 : totalmem();
  const availBytes = parsed ? parsed.availableKb * 1024 : freemem();
  const usedBytes = Math.max(0, totalBytes - availBytes);
  return {
    pct: totalBytes > 0 ? clampPct((usedBytes / totalBytes) * 100) : 0,
    usedGb: gb(usedBytes),
    totalGb: gb(totalBytes),
  };
}

function diskNow(): { pct: number; freeGb: number } | null {
  try {
    const { bsize, blocks, bfree, bavail } = statfsSync("/") as unknown as
      { bsize: number; blocks: number; bfree: number; bavail: number };
    if (!blocks || !bsize) return null;
    // Match df: capacity is measured against what a non-root user can actually claim.
    const usable = blocks - (bfree - bavail);
    return { pct: usable > 0 ? clampPct(((usable - bavail) / usable) * 100) : 0, freeGb: gb(bavail * bsize) };
  } catch {
    return null;
  }
}

export function hostStats(): HostStats | null {
  const mem = memNow();
  const disk = diskNow();
  if (!disk) return null;
  return {
    cpu: cpuNow(),
    mem: mem.pct,
    memUsedGb: mem.usedGb,
    memTotalGb: mem.totalGb,
    disk: disk.pct,
    diskFreeGb: disk.freeGb,
  };
}
