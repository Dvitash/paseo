import { describe, expect, it } from "vitest";
import {
  HostPerformanceGetSnapshotRequestSchema,
  HostPerformanceGetSnapshotResponseSchema,
  HostPerformanceGpusSchema,
  HostPerformanceMemorySchema,
  HostPerformanceSampleSchema,
  HostPerformanceSnapshotSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  type HostPerformanceSnapshot,
} from "./messages.js";

describe("Host Performance protocol schemas", () => {
  const validSnapshot: HostPerformanceSnapshot = {
    sample: {
      sampledAt: 1773160000000,
      cpu: {
        utilizationPercent: 42.5,
        logicalCores: 8,
      },
      memory: {
        usedBytes: 8 * 1024 * 1024 * 1024,
        totalBytes: 16 * 1024 * 1024 * 1024,
      },
      gpus: {
        status: "available",
        devices: [
          {
            id: "gpu-0",
            name: "NVIDIA RTX 4090",
            utilizationPercent: 78.2,
            memory: {
              usedBytes: 4 * 1024 * 1024 * 1024,
              totalBytes: 24 * 1024 * 1024 * 1024,
            },
          },
        ],
      },
    },
    history: [
      {
        sampledAt: 1773159980000,
        cpuPercent: 35.0,
        memoryPercent: 50.0,
        gpuPercent: 60.0,
      },
      {
        sampledAt: 1773160000000,
        cpuPercent: 42.5,
        memoryPercent: 50.0,
        gpuPercent: 78.2,
      },
    ],
  };

  it("parses valid HostPerformanceSnapshot", () => {
    const parsed = HostPerformanceSnapshotSchema.parse(validSnapshot);
    expect(parsed).toEqual(validSnapshot);
  });

  it("parses GPU status variants: available, unavailable, none", () => {
    const available = HostPerformanceGpusSchema.parse({
      status: "available",
      devices: [
        {
          id: "gpu-1",
          name: "Test GPU",
          utilizationPercent: null,
          memory: null,
        },
      ],
    });
    expect(available.status).toBe("available");

    const unavailable = HostPerformanceGpusSchema.parse({
      status: "unavailable",
    });
    expect(unavailable.status).toBe("unavailable");

    const none = HostPerformanceGpusSchema.parse({
      status: "none",
    });
    expect(none.status).toBe("none");
  });

  it("enforces memory non-negative finite bytes", () => {
    expect(() =>
      HostPerformanceMemorySchema.parse({
        usedBytes: -1,
        totalBytes: 1000,
      }),
    ).toThrow();

    expect(() =>
      HostPerformanceMemorySchema.parse({
        usedBytes: Number.POSITIVE_INFINITY,
        totalBytes: 1000,
      }),
    ).toThrow();
  });

  it("enforces percent ranges 0..100 and finite numbers", () => {
    expect(() =>
      HostPerformanceSampleSchema.parse({
        ...validSnapshot.sample,
        cpu: {
          utilizationPercent: 105,
          logicalCores: 4,
        },
      }),
    ).toThrow();

    expect(() =>
      HostPerformanceSampleSchema.parse({
        ...validSnapshot.sample,
        cpu: {
          utilizationPercent: -5,
          logicalCores: 4,
        },
      }),
    ).toThrow();
  });

  it("enforces logical cores as non-negative integer", () => {
    expect(() =>
      HostPerformanceSampleSchema.parse({
        ...validSnapshot.sample,
        cpu: {
          utilizationPercent: 20,
          logicalCores: 3.5,
        },
      }),
    ).toThrow();

    expect(() =>
      HostPerformanceSampleSchema.parse({
        ...validSnapshot.sample,
        cpu: {
          utilizationPercent: 20,
          logicalCores: -1,
        },
      }),
    ).toThrow();
  });

  it("enforces history maximum 30 points", () => {
    const points = Array.from({ length: 31 }, (_, i) => ({
      sampledAt: 1773160000000 + i * 2000,
      cpuPercent: 10,
      memoryPercent: 20,
      gpuPercent: null,
    }));
    expect(() =>
      HostPerformanceSnapshotSchema.parse({
        sample: validSnapshot.sample,
        history: points,
      }),
    ).toThrow();
  });

  it("parses host.performance.get_snapshot request and response in session message unions", () => {
    const req = HostPerformanceGetSnapshotRequestSchema.parse({
      type: "host.performance.get_snapshot.request",
      requestId: "req-perf-1",
    });
    expect(SessionInboundMessageSchema.parse(req)).toEqual(req);

    const res = HostPerformanceGetSnapshotResponseSchema.parse({
      type: "host.performance.get_snapshot.response",
      payload: {
        requestId: "req-perf-1",
        snapshot: validSnapshot,
      },
    });
    expect(SessionOutboundMessageSchema.parse(res)).toEqual(res);
  });

  it("advertises hostPerformance feature optionally on server_info without breaking legacy parsing", () => {
    const legacy = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-legacy",
    });
    expect(legacy.features?.hostPerformance).toBeUndefined();

    const enabled = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-perf",
      features: {
        hostPerformance: true,
      },
    });
    expect(enabled.features?.hostPerformance).toBe(true);
  });
});
