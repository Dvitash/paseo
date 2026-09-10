import type {
  HostPerformanceGpus,
  HostPerformanceMemory,
} from "@getpaseo/protocol/host-performance";

export function formatPercent(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct) || pct < 0) {
    return "-";
  }
  return `${Math.round(pct)}%`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return "-";
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const kibi = bytes / 1024;
  if (kibi < 1024) {
    return `${kibi.toFixed(1)} KB`;
  }
  const mebi = kibi / 1024;
  if (mebi < 1024) {
    return `${mebi.toFixed(1)} MB`;
  }
  const gibi = mebi / 1024;
  if (gibi < 1024) {
    return `${gibi.toFixed(1)} GB`;
  }
  const tebi = gibi / 1024;
  return `${tebi.toFixed(1)} TB`;
}

export function calculateBusiestGpuPercent(
  gpus: HostPerformanceGpus | null | undefined,
): number | null {
  if (!gpus || gpus.status !== "available" || gpus.devices.length === 0) {
    return null;
  }
  let maxPercent: number | null = null;
  for (const device of gpus.devices) {
    if (device.utilizationPercent != null && Number.isFinite(device.utilizationPercent)) {
      if (maxPercent == null || device.utilizationPercent > maxPercent) {
        maxPercent = device.utilizationPercent;
      }
    }
  }
  return maxPercent;
}

export function calculateMemoryPercent(
  memory: HostPerformanceMemory | null | undefined,
): number | null {
  if (!memory || !Number.isFinite(memory.totalBytes) || memory.totalBytes <= 0) {
    return null;
  }
  if (!Number.isFinite(memory.usedBytes) || memory.usedBytes < 0) {
    return null;
  }
  const percent = (memory.usedBytes / memory.totalBytes) * 100;
  return Math.min(100, Math.max(0, percent));
}

export function formatMemoryUsage(memory: HostPerformanceMemory | null | undefined): string {
  if (!memory) {
    return "-";
  }
  return `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`;
}

export function isFreshnessStale(
  updatedAt: number | null | undefined,
  now = Date.now(),
  thresholdMs = 10_000,
): boolean {
  if (updatedAt == null || !Number.isFinite(updatedAt) || updatedAt <= 0) {
    return true;
  }
  return now - updatedAt > thresholdMs;
}
