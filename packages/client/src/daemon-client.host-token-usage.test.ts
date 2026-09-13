import { describe, expect, it } from "vitest";
import { DaemonClient, type DaemonTransport } from "./daemon-client.js";
import type { HostTokenUsageSnapshot } from "@getpaseo/protocol/host-token-usage";

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

describe("DaemonClient Host Token Usage RPC", () => {
  it("sends host.token_usage.get_snapshot.request and returns snapshot payload", async () => {
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

      const mockSnapshot: HostTokenUsageSnapshot = {
        status: "available",
        ranges: {
          "1h": { inputTokens: 100, cacheReadTokens: 50, outputTokens: 20 },
          "24h": { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 200 },
          "7d": { inputTokens: 7000, cacheReadTokens: 3500, outputTokens: 1400 },
          "30d": { inputTokens: 30000, cacheReadTokens: 15000, outputTokens: 6000 },
          all: { inputTokens: 100000, cacheReadTokens: 50000, outputTokens: 20000 },
        },
        fetchedAt: "2026-09-13T12:00:00.000Z",
      };

      const snapshotPromise = client.getHostTokenUsageSnapshot({
        requestId: "req-token-1",
        force: true,
      });

      expect(mock.sent.length).toBe(1);
      const sentPayload = JSON.parse(mock.sent[0] as string);
      expect(sentPayload).toEqual({
        type: "session",
        message: {
          type: "host.token_usage.get_snapshot.request",
          requestId: "req-token-1",
          force: true,
        },
      });

      mock.emitMessage({
        type: "session",
        message: {
          type: "host.token_usage.get_snapshot.response",
          payload: {
            requestId: "req-token-1",
            snapshot: mockSnapshot,
          },
        },
      });

      const result = await snapshotPromise;
      expect(result).toEqual(mockSnapshot);
    } finally {
      client.close();
    }
  });
});
