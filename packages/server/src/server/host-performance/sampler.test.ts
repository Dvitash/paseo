import { describe, expect, it } from "vitest";
import { HostPerformanceSampler } from "./sampler.js";
import type { HostSystemReading } from "./system.js";

function reading(idle: number, total: number): HostSystemReading {
  return {
    cpu: { idle, total, logicalCores: 4 },
    memory: { usedBytes: 600, totalBytes: 1000 },
    gpus: {
      status: "available",
      devices: [
        { id: "gpu-1", name: "First GPU", utilizationPercent: 20, memory: null },
        { id: "gpu-2", name: "Second GPU", utilizationPercent: 80, memory: null },
      ],
    },
  };
}

describe("HostPerformanceSampler", () => {
  it("coalesces clients, caches readings, and computes CPU load from counter deltas", async () => {
    let now = 100_000;
    let calls = 0;
    const sampler = new HostPerformanceSampler({
      now: () => now,
      read: async () => {
        calls += 1;
        return reading(calls * 100, calls * 400);
      },
    });

    expect(calls).toBe(0);
    const [first, concurrent] = await Promise.all([sampler.getSnapshot(), sampler.getSnapshot()]);
    expect(calls).toBe(1);
    expect(first).toBe(concurrent);
    expect(first.sample.cpu).toEqual({ utilizationPercent: null, logicalCores: 4 });
    expect(first.history).toEqual([
      { sampledAt: now, cpuPercent: null, memoryPercent: 60, gpuPercent: 80 },
    ]);

    now += 1000;
    expect(await sampler.getSnapshot()).toBe(first);
    expect(calls).toBe(1);
    now += 1500;
    const next = await sampler.getSnapshot();
    expect(calls).toBe(2);
    expect(next.sample.cpu).toEqual({ utilizationPercent: 75, logicalCores: 4 });
    expect(next.history).toHaveLength(2);
    expect(first.history).toHaveLength(1);
  });

  it("does no work without requests and resets the CPU baseline after idle gaps", async () => {
    let now = 100_000;
    let calls = 0;
    const sampler = new HostPerformanceSampler({
      now: () => now,
      read: async () => {
        calls += 1;
        return reading(calls * 100, calls * 400);
      },
    });
    await sampler.getSnapshot();
    now += 120_000;
    expect(calls).toBe(1);
    const resumed = await sampler.getSnapshot();
    expect(calls).toBe(2);
    expect(resumed.sample.cpu.utilizationPercent).toBeNull();
    expect(resumed.history).toEqual([
      { sampledAt: now, cpuPercent: null, memoryPercent: 60, gpuPercent: 80 },
    ]);
  });

  it("bounds history to thirty recent samples", async () => {
    let now = 100_000;
    const sampler = new HostPerformanceSampler({
      now: () => now,
      read: async () => reading(100, 400),
    });
    for (let index = 0; index < 40; index += 1) {
      await sampler.getSnapshot();
      now += 2000;
    }
    const snapshot = await sampler.getSnapshot();
    expect(snapshot.history).toHaveLength(30);
    expect(snapshot.history[0]?.sampledAt).toBe(now - 58_000);
    expect(snapshot.history[29]?.sampledAt).toBe(now);
  });

  it("leaves missing hardware and invalid CPU deltas unavailable", async () => {
    let now = 100_000;
    let current = reading(100, 400);
    const sampler = new HostPerformanceSampler({ now: () => now, read: async () => current });
    await sampler.getSnapshot();
    now += 2500;
    current = {
      cpu: { idle: 50, total: 200, logicalCores: 4 },
      memory: null,
      gpus: { status: "none" },
    };
    const reset = await sampler.getSnapshot();
    expect(reset.sample).toEqual({
      sampledAt: now,
      cpu: { utilizationPercent: null, logicalCores: 4 },
      memory: null,
      gpus: { status: "none" },
    });
    expect(reset.history[1]).toEqual({
      sampledAt: now,
      cpuPercent: null,
      memoryPercent: null,
      gpuPercent: null,
    });
    now += 2500;
    current = { ...current, cpu: { idle: 60, total: 600, logicalCores: 8 } };
    expect((await sampler.getSnapshot()).sample.cpu.utilizationPercent).toBeNull();
  });

  it("recovers after a failed read without leaving an in-flight request stuck", async () => {
    let fail = true;
    const failure = new Error("reader failure");
    const sampler = new HostPerformanceSampler({
      read: async () => {
        if (fail) throw failure;
        return reading(100, 400);
      },
    });
    await expect(sampler.getSnapshot()).rejects.toBe(failure);
    fail = false;
    expect((await sampler.getSnapshot()).sample.memory).toEqual({
      usedBytes: 600,
      totalBytes: 1000,
    });
  });

  it("invalidates cache and history when the host clock moves backwards", async () => {
    let now = 100_000;
    const sampler = new HostPerformanceSampler({
      now: () => now,
      read: async () => reading(100, 400),
    });
    await sampler.getSnapshot();
    now -= 10_000;
    const snapshot = await sampler.getSnapshot();
    expect(snapshot.sample.sampledAt).toBe(90_000);
    expect(snapshot.sample.cpu.utilizationPercent).toBeNull();
    expect(snapshot.history).toEqual([
      { sampledAt: 90_000, cpuPercent: null, memoryPercent: 60, gpuPercent: 80 },
    ]);
  });
});
