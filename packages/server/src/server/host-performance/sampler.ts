import type {
  HostPerformanceHistoryPoint,
  HostPerformanceSample,
  HostPerformanceSnapshot,
} from "@getpaseo/protocol/host-performance";
import { createHostSystemReader, type HostCpuCounters, type HostSystemReading } from "./system.js";

const CACHE_MS = 2000;
const CPU_BASELINE_MAX_AGE_MS = 10_000;
const HISTORY_MS = 60_000;
const HISTORY_LIMIT = 30;

interface SamplerOptions {
  read?: () => Promise<HostSystemReading>;
  now?: () => number;
}

interface CpuBaseline {
  sampledAt: number;
  counters: HostCpuCounters;
}

function cpuUtilization(
  current: HostCpuCounters,
  previous: CpuBaseline | null,
  now: number,
): number | null {
  if (!previous) return null;
  const elapsed = now - previous.sampledAt;
  const sameCores = current.logicalCores === previous.counters.logicalCores;
  const isRecent = elapsed > 0 && elapsed <= CPU_BASELINE_MAX_AGE_MS;
  if (!sameCores || !isRecent) return null;
  const total = current.total - previous.counters.total;
  const idle = current.idle - previous.counters.idle;
  const validDelta = total > 0 && idle >= 0 && idle <= total;
  if (!validDelta) return null;
  return ((total - idle) / total) * 100;
}

function historyPoint(sample: HostPerformanceSample): HostPerformanceHistoryPoint {
  let memoryPercent: number | null = null;
  if (sample.memory && sample.memory.totalBytes > 0) {
    memoryPercent = (sample.memory.usedBytes / sample.memory.totalBytes) * 100;
  }
  let gpuPercent: number | null = null;
  if (sample.gpus.status === "available") {
    for (const gpu of sample.gpus.devices) {
      if (gpu.utilizationPercent !== null) {
        gpuPercent = Math.max(gpuPercent ?? 0, gpu.utilizationPercent);
      }
    }
  }
  return {
    sampledAt: sample.sampledAt,
    cpuPercent: sample.cpu.utilizationPercent,
    memoryPercent,
    gpuPercent,
  };
}

// Requests are the sampling demand. No session, timer, or agent keeps this running after the UI leaves.
export class HostPerformanceSampler {
  private readonly read: () => Promise<HostSystemReading>;
  private readonly now: () => number;
  private snapshot: HostPerformanceSnapshot | null = null;
  private inFlight: Promise<HostPerformanceSnapshot> | null = null;
  private baseline: CpuBaseline | null = null;

  constructor(options: SamplerOptions = {}) {
    this.read = options.read ?? createHostSystemReader();
    this.now = options.now ?? Date.now;
  }

  getSnapshot(): Promise<HostPerformanceSnapshot> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (this.snapshot) {
      const age = now - this.snapshot.sample.sampledAt;
      if (age >= 0 && age < CACHE_MS) return Promise.resolve(this.snapshot);
    }
    this.inFlight = this.sample(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async sample(now: number): Promise<HostPerformanceSnapshot> {
    const reading = await this.read();
    const utilizationPercent = cpuUtilization(reading.cpu, this.baseline, now);
    this.baseline = { sampledAt: now, counters: reading.cpu };
    const sample: HostPerformanceSample = {
      sampledAt: now,
      cpu: { utilizationPercent, logicalCores: reading.cpu.logicalCores },
      memory: reading.memory,
      gpus: reading.gpus,
    };
    const previous = this.snapshot ? this.snapshot.history : [];
    const recent = previous.filter(
      (point) => point.sampledAt > now - HISTORY_MS && point.sampledAt < now,
    );
    const history = [...recent, historyPoint(sample)].slice(-HISTORY_LIMIT);
    this.snapshot = { sample, history };
    return this.snapshot;
  }
}
