import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { HostPerformanceSnapshotSchema } from "@getpaseo/protocol/host-performance";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

describe("Host Performance Telemetry (daemon E2E)", () => {
  let daemon: TestPaseoDaemon;
  const clients: DaemonClient[] = [];

  beforeEach(async () => {
    daemon = await createTestPaseoDaemon({ cleanup: true });
  });

  afterEach(async () => {
    try {
      for (const client of clients) {
        await client.close();
      }
    } finally {
      clients.length = 0;
      if (daemon) {
        await daemon.close();
      }
    }
  });

  function createClient(): DaemonClient {
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      reconnect: { enabled: false },
    });
    clients.push(client);
    return client;
  }

  test("advertises hostPerformance feature in server_info with no unsolicited telemetry on connect", async () => {
    const rawMessages: SessionOutboundMessage[] = [];
    const client = createClient();
    client.subscribeRawMessages((msg) => rawMessages.push(msg));
    await client.connect();

    const serverInfo = client.getLastServerInfoMessage();
    if (!serverInfo) {
      throw new Error("Expected server_info message on connect");
    }
    expect(serverInfo.features?.hostPerformance).toBe(true);

    const unsolicitedHostPerfMessages = rawMessages.filter((msg) =>
      msg.type.startsWith("host.performance."),
    );
    expect(unsolicitedHostPerfMessages).toHaveLength(0);
  });

  test("fetches live host performance CPU/RAM snapshot via client RPC with exact schema and history mapping", async () => {
    const client = createClient();
    await client.connect();

    const snapshot = await client.getHostPerformanceSnapshot();

    // Exact schema.parse roundtrip
    const parsed = HostPerformanceSnapshotSchema.parse(snapshot);
    expect(parsed).toEqual(snapshot);

    expect(typeof snapshot.sample.sampledAt).toBe("number");
    expect(snapshot.sample.sampledAt).toBeGreaterThan(0);

    // Concrete first sample: CPU baseline has no predecessor, so utilizationPercent is strictly null
    expect(snapshot.sample.cpu.logicalCores).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(snapshot.sample.cpu.logicalCores)).toBe(true);
    expect(snapshot.sample.cpu.utilizationPercent).toBeNull();

    // Memory null guard throws, then unconditional asserts
    if (!snapshot.sample.memory) {
      throw new Error("Expected host memory sample to be present");
    }
    expect(snapshot.sample.memory.usedBytes).toBeGreaterThan(0);
    expect(snapshot.sample.memory.totalBytes).toBeGreaterThan(0);
    expect(snapshot.sample.memory.usedBytes).toBeLessThanOrEqual(snapshot.sample.memory.totalBytes);

    // GPU metrics
    expect(["available", "unavailable", "none"]).toContain(snapshot.sample.gpus.status);

    // History exact mapping: first sample produces exactly one history point derived from that sample
    expect(snapshot.history).toHaveLength(1);
    const point = snapshot.history[0];
    expect(point.sampledAt).toBe(snapshot.sample.sampledAt);
    expect(point.cpuPercent).toBeNull();
    expect(point.memoryPercent).toBe(
      (snapshot.sample.memory.usedBytes / snapshot.sample.memory.totalBytes) * 100,
    );
    if (snapshot.sample.gpus.status === "available" && snapshot.sample.gpus.devices.length > 0) {
      const avg =
        snapshot.sample.gpus.devices.reduce((sum, d) => sum + (d.utilizationPercent ?? 0), 0) /
        snapshot.sample.gpus.devices.length;
      expect(point.gpuPercent).toBe(avg);
    } else {
      expect(point.gpuPercent).toBeNull();
    }
  });

  test("concurrent clients receive the same sample from the shared daemon sampler", async () => {
    const client1 = createClient();
    const client2 = createClient();

    await Promise.all([client1.connect(), client2.connect()]);

    const [snapshot1, snapshot2] = await Promise.all([
      client1.getHostPerformanceSnapshot(),
      client2.getHostPerformanceSnapshot(),
    ]);

    expect(snapshot1.sample.sampledAt).toBe(snapshot2.sample.sampledAt);
    expect(snapshot1.sample.cpu).toEqual(snapshot2.sample.cpu);
    expect(snapshot1.sample.memory).toEqual(snapshot2.sample.memory);
    expect(snapshot1.sample.gpus).toEqual(snapshot2.sample.gpus);
  });
});
