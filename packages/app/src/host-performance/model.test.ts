import { describe, expect, it } from "vitest";
import type {
  HostPerformanceGpus,
  HostPerformanceHistoryPoint,
} from "@getpaseo/protocol/host-performance";
import {
  calculateBusiestGpuPercent,
  calculateMemoryPercent,
  formatBytes,
  formatMemoryUsage,
  formatPercent,
  isFreshnessStale,
} from "./format";
import { generateSparklineSegments, resolveTargetHostServerId } from "./model";

describe("host performance model and formatting", () => {
  describe("resolveTargetHostServerId", () => {
    it("returns explicit server id when available in host list", () => {
      const result = resolveTargetHostServerId({
        explicitServerId: "remote-2",
        defaultServerId: "local-1",
        availableHostServerIds: ["local-1", "remote-2", "remote-3"],
      });
      expect(result).toBe("remote-2");
    });

    it("falls back to default server id when explicit server id is removed or invalid", () => {
      const result = resolveTargetHostServerId({
        explicitServerId: "removed-host",
        defaultServerId: "local-1",
        availableHostServerIds: ["local-1", "remote-2"],
      });
      expect(result).toBe("local-1");
    });

    it("falls back to first available host when default server id is missing or not in available hosts", () => {
      const result = resolveTargetHostServerId({
        explicitServerId: null,
        defaultServerId: "offline-host",
        availableHostServerIds: ["backup-1", "backup-2"],
      });
      expect(result).toBe("backup-1");
    });

    it("returns null when no hosts are available", () => {
      const result = resolveTargetHostServerId({
        explicitServerId: "any",
        defaultServerId: "any",
        availableHostServerIds: [],
      });
      expect(result).toBeNull();
    });
  });

  describe("formatPercent", () => {
    it("formats valid percentages as whole numbers with % suffix", () => {
      expect(formatPercent(0)).toBe("0%");
      expect(formatPercent(42.4)).toBe("42%");
      expect(formatPercent(42.6)).toBe("43%");
      expect(formatPercent(100)).toBe("100%");
    });

    it("returns dash for null or undefined", () => {
      expect(formatPercent(null)).toBe("-");
      expect(formatPercent(undefined)).toBe("-");
    });
  });

  describe("formatBytes", () => {
    it("formats byte magnitudes cleanly", () => {
      expect(formatBytes(512)).toBe("512 B");
      expect(formatBytes(1536)).toBe("1.5 KB");
      expect(formatBytes(1024 * 1024 * 256)).toBe("256.0 MB");
      expect(formatBytes(1024 * 1024 * 1024 * 16)).toBe("16.0 GB");
      expect(formatBytes(1024 * 1024 * 1024 * 1024 * 2)).toBe("2.0 TB");
    });

    it("returns dash for null or undefined", () => {
      expect(formatBytes(null)).toBe("-");
      expect(formatBytes(undefined)).toBe("-");
    });
  });

  describe("calculateMemoryPercent and formatMemoryUsage", () => {
    it("calculates percentage within 0 to 100 bounds", () => {
      expect(calculateMemoryPercent({ usedBytes: 8, totalBytes: 16 })).toBe(50);
      expect(calculateMemoryPercent({ usedBytes: 0, totalBytes: 16 })).toBe(0);
      expect(calculateMemoryPercent({ usedBytes: 16, totalBytes: 16 })).toBe(100);
    });

    it("returns null on null or zero total memory", () => {
      expect(calculateMemoryPercent(null)).toBeNull();
      expect(calculateMemoryPercent({ usedBytes: 8, totalBytes: 0 })).toBeNull();
    });

    it("formats memory usage as used / total", () => {
      expect(
        formatMemoryUsage({
          usedBytes: 1024 * 1024 * 1024 * 8,
          totalBytes: 1024 * 1024 * 1024 * 16,
        }),
      ).toBe("8.0 GB / 16.0 GB");
      expect(formatMemoryUsage(null)).toBe("-");
    });
  });

  describe("calculateBusiestGpuPercent", () => {
    it("returns null when status is none or unavailable", () => {
      expect(calculateBusiestGpuPercent({ status: "none" })).toBeNull();
      expect(calculateBusiestGpuPercent({ status: "unavailable" })).toBeNull();
      expect(calculateBusiestGpuPercent(null)).toBeNull();
    });

    it("finds highest utilization among multiple available GPUs", () => {
      const gpus: HostPerformanceGpus = {
        status: "available",
        devices: [
          { id: "gpu-0", name: "GPU 0", utilizationPercent: 35, memory: null },
          { id: "gpu-1", name: "GPU 1", utilizationPercent: 92, memory: null },
          { id: "gpu-2", name: "GPU 2", utilizationPercent: 12, memory: null },
        ],
      };
      expect(calculateBusiestGpuPercent(gpus)).toBe(92);
    });

    it("handles devices with null utilization", () => {
      const partialGpus: HostPerformanceGpus = {
        status: "available",
        devices: [
          { id: "gpu-0", name: "GPU 0", utilizationPercent: null, memory: null },
          { id: "gpu-1", name: "GPU 1", utilizationPercent: 44, memory: null },
        ],
      };
      expect(calculateBusiestGpuPercent(partialGpus)).toBe(44);

      const allNullGpus: HostPerformanceGpus = {
        status: "available",
        devices: [{ id: "gpu-0", name: "GPU 0", utilizationPercent: null, memory: null }],
      };
      expect(calculateBusiestGpuPercent(allNullGpus)).toBeNull();
    });
  });

  describe("isFreshnessStale", () => {
    it("returns false for fresh timestamps and true for stale timestamps", () => {
      const now = 1_000_000;
      expect(isFreshnessStale(now - 2_000, now, 10_000)).toBe(false);
      expect(isFreshnessStale(now - 11_000, now, 10_000)).toBe(true);
      expect(isFreshnessStale(null, now)).toBe(true);
    });
  });

  describe("generateSparklineSegments with gap handling", () => {
    it("returns empty segments for empty points or non-positive dimensions", () => {
      expect(
        generateSparklineSegments({
          points: [],
          getValue: (p) => p.cpuPercent,
          width: 200,
          height: 40,
        }),
      ).toEqual([]);
    });

    it("produces a single dot segment for an isolated single point", () => {
      const now = 60_000;
      const points: HostPerformanceHistoryPoint[] = [
        { sampledAt: 60_000, cpuPercent: 50, memoryPercent: null, gpuPercent: null },
      ];
      const segments = generateSparklineSegments({
        points,
        getValue: (p) => p.cpuPercent,
        width: 100,
        height: 50,
        now,
        timeWindowMs: 60_000,
      });

      expect(segments).toHaveLength(1);
      expect(segments[0]).toEqual({
        type: "dot",
        key: "dot-60000",
        cx: 100,
        cy: 25,
      });
    });

    it("produces a line segment for contiguous points within maxGapMs", () => {
      const now = 60_000;
      const points: HostPerformanceHistoryPoint[] = [
        { sampledAt: 56_000, cpuPercent: 0, memoryPercent: null, gpuPercent: null },
        { sampledAt: 58_000, cpuPercent: 50, memoryPercent: null, gpuPercent: null },
        { sampledAt: 60_000, cpuPercent: 100, memoryPercent: null, gpuPercent: null },
      ];
      const segments = generateSparklineSegments({
        points,
        getValue: (p) => p.cpuPercent,
        width: 100,
        height: 50,
        now,
        timeWindowMs: 60_000,
        maxGapMs: 6_000,
      });

      expect(segments).toHaveLength(1);
      expect(segments[0].type).toBe("line");
      expect(segments[0].key).toBe("line-56000");
      if (segments[0].type === "line") {
        expect(segments[0].path).toContain("M ");
        expect(segments[0].path).toContain("L ");
      }
    });

    it("splits into separate segments when points exceed maxGapMs", () => {
      const now = 60_000;
      const points: HostPerformanceHistoryPoint[] = [
        { sampledAt: 30_000, cpuPercent: 20, memoryPercent: null, gpuPercent: null },
        { sampledAt: 32_000, cpuPercent: 30, memoryPercent: null, gpuPercent: null },
        { sampledAt: 52_000, cpuPercent: 80, memoryPercent: null, gpuPercent: null },
      ];

      const segments = generateSparklineSegments({
        points,
        getValue: (p) => p.cpuPercent,
        width: 100,
        height: 50,
        now,
        timeWindowMs: 60_000,
        maxGapMs: 6_000,
      });

      expect(segments[0].type).toBe("line");
      expect(segments[0].key).toBe("line-30000");
      expect(segments[1].type).toBe("dot");
      expect(segments[1].key).toBe("dot-52000");
    });

    it("breaks line when null value is encountered in sequence", () => {
      const now = 60_000;
      const points: HostPerformanceHistoryPoint[] = [
        { sampledAt: 50_000, cpuPercent: 20, memoryPercent: null, gpuPercent: null },
        { sampledAt: 52_000, cpuPercent: null, memoryPercent: null, gpuPercent: null },
        { sampledAt: 54_000, cpuPercent: 40, memoryPercent: null, gpuPercent: null },
      ];

      const segments = generateSparklineSegments({
        points,
        getValue: (p) => p.cpuPercent,
        width: 100,
        height: 50,
        now,
        timeWindowMs: 60_000,
        maxGapMs: 6_000,
      });

      expect(segments).toHaveLength(2);
      expect(segments[0].type).toBe("dot");
      expect(segments[1].type).toBe("dot");
    });
  });
});
