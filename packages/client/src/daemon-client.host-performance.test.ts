import { describe, expect, it } from "vitest";
import { DaemonClient, type DaemonTransport } from "./daemon-client.js";
import type { HostPerformanceSnapshot } from "@getpaseo/protocol/host-performance";

function createMockTransport() {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  const closeCalls: Array<{ code?: number; reason?: string }> = [];

  let onMessage: (data: unknown, isBinary: boolean) => void = () => {};
  let onOpen: () => void = () => {};

  const transport: DaemonTransport = {
    send: (data) => {
      sent.push(data);
    },
    close: (code?: number, reason?: string) => {
      closeCalls.push({ code, reason });
    },
    onMessage: (handler: (data: unknown, isBinary: boolean) => void) => {
      onMessage = handler;
      return () => {};
    },
    onOpen: (handler) => {
      onOpen = handler;
      return () => {};
    },
    onClose: (_handler) => () => {},
    onError: (_handler) => () => {},
  };

  return {
    transport,
    sent,
    closeCalls,
    triggerOpen: () => {
      onOpen();
      sent.length = 0;
      onMessage(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: "test-daemon",
              version: "1.0.0",
              hostname: "test-daemon",
              features: { hostPerformance: true },
            },
          },
        }),
        false,
      );
    },
    emitMessage: (msg: unknown) => {
      onMessage(typeof msg === "string" ? msg : JSON.stringify(msg), false);
    },
  };
}

describe("DaemonClient Host Performance RPC", () => {
  it("sends host.performance.get_snapshot.request and returns snapshot payload", async () => {
    const mock = createMockTransport();
    const client = new DaemonClient({
      url: "ws://test",
      clientId: "test-client",
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });

    try {
      const connectPromise = client.connect();
      mock.triggerOpen();
      await connectPromise;

      const mockSnapshot: HostPerformanceSnapshot = {
        sample: {
          sampledAt: 1773160000000,
          cpu: { utilizationPercent: 50, logicalCores: 8 },
          memory: { usedBytes: 4000, totalBytes: 8000 },
          gpus: { status: "none" },
        },
        history: [],
      };

      const promise = client.getHostPerformanceSnapshot({ requestId: "req-perf-1" });

      expect(mock.sent).toHaveLength(1);
      const firstSent = mock.sent[0];
      if (typeof firstSent !== "string") {
        throw new Error("Expected string sent frame");
      }
      const sentMsg = JSON.parse(firstSent) as {
        type?: string;
        message?: { type?: string; requestId?: string };
      };
      expect(sentMsg).toEqual({
        type: "session",
        message: {
          type: "host.performance.get_snapshot.request",
          requestId: "req-perf-1",
        },
      });

      mock.emitMessage({
        type: "session",
        message: {
          type: "host.performance.get_snapshot.response",
          payload: {
            requestId: "req-perf-1",
            snapshot: mockSnapshot,
          },
        },
      });

      const result = await promise;
      expect(result).toEqual(mockSnapshot);
    } finally {
      await client.close();
    }
  });
});
