import { describe, expect, it } from "vitest";
import {
  HostTokenUsageGetSnapshotRequestSchema,
  HostTokenUsageGetSnapshotResponseSchema,
  HostTokenUsageSnapshotSchema,
} from "./host-token-usage.js";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";

describe("Host token usage protocol", () => {
  const validSnapshot = {
    status: "available" as const,
    ranges: {
      "1h": { inputTokens: 1000, cacheReadTokens: 5000, outputTokens: 200 },
      "24h": { inputTokens: 10000, cacheReadTokens: 50000, outputTokens: 2000 },
      "7d": { inputTokens: 70000, cacheReadTokens: 350000, outputTokens: 14000 },
      "30d": { inputTokens: 300000, cacheReadTokens: 1500000, outputTokens: 60000 },
      all: { inputTokens: 1000000, cacheReadTokens: 5000000, outputTokens: 200000 },
    },
    fetchedAt: "2026-09-13T12:00:00.000Z",
  };

  it("parses valid available snapshot", () => {
    const parsed = HostTokenUsageSnapshotSchema.parse(validSnapshot);
    expect(parsed.status).toBe("available");
    expect(parsed.ranges?.["1h"].inputTokens).toBe(1000);
  });

  it("parses unavailable snapshot", () => {
    const unavailable = {
      status: "unavailable" as const,
      error: "omp not found",
      fetchedAt: "2026-09-13T12:00:00.000Z",
    };
    const parsed = HostTokenUsageSnapshotSchema.parse(unavailable);
    expect(parsed.status).toBe("unavailable");
    expect(parsed.error).toBe("omp not found");
  });

  it("parses request and response messages in session message unions", () => {
    const req = HostTokenUsageGetSnapshotRequestSchema.parse({
      type: "host.token_usage.get_snapshot.request",
      requestId: "req-token-1",
      force: true,
    });
    expect(SessionInboundMessageSchema.parse(req)).toEqual(req);

    const res = HostTokenUsageGetSnapshotResponseSchema.parse({
      type: "host.token_usage.get_snapshot.response",
      payload: {
        requestId: "req-token-1",
        snapshot: validSnapshot,
      },
    });
    expect(SessionOutboundMessageSchema.parse(res)).toEqual(res);
  });
});
