import { readFileSync } from "node:fs";

// Above this a cgroup v1 limit means "no limit" (the kernel's page-rounded max).
const CGROUP_V1_UNLIMITED = 2 ** 60;

/**
 * The container's memory limit in bytes, from cgroup v2 memory.max or cgroup v1
 * memory.limit_in_bytes, or null when there is none or it can't be read.
 */
export function readCgroupMemoryLimit(read: (path: string) => string = (path) => readFileSync(path, "utf8")): number | null {
  for (const path of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    let raw: string;
    try { raw = read(path).trim(); } catch { continue; }
    if (!/^\d+$/.test(raw)) return null; // "max": no limit
    const n = Number(raw);
    return n > 0 && n < CGROUP_V1_UNLIMITED ? n : null;
  }
  return null;
}
