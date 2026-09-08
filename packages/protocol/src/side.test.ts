import { describe, expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";
import { validateWSOutboundMessage } from "./validation/ws-outbound.js";

const chat = {
  mainAgentId: "main-1",
  sideAgentId: "side-1",
  status: "idle",
  error: null,
  messages: [
    { id: "question-1", role: "user", text: "What changed?" },
    { id: "answer-1", role: "assistant", text: "The parser changed." },
  ],
  steeringProposal: "Please test the parser.",
};

describe("Side protocol", () => {
  test.each(["get", "send", "stop"] as const)("routes %s requests and responses", (operation) => {
    const request = {
      type: `agent.side.${operation}.request`,
      requestId: "request-1",
      mainAgentId: "main-1",
      ...(operation === "send" ? { text: "What changed?" } : {}),
    };
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    const response = {
      type: `agent.side.${operation}.response`,
      payload: { requestId: "request-1", chat, error: null },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    expect(validateWSOutboundMessage({ type: "session", message: response }).success).toBe(true);
  });

  test.each(["", "x".repeat(32_001)])("rejects an empty or oversized prompt", (text) => {
    const parsed = SessionInboundMessageSchema.safeParse({
      type: "agent.side.send.request",
      requestId: "request-1",
      mainAgentId: "main-1",
      text,
    });
    expect(parsed.success).toBe(false);
  });

  test("accepts actionable errors without a conversation", () => {
    const response = {
      type: "agent.side.send.response",
      payload: { requestId: "request-1", chat: null, error: "Provider unavailable" },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  test("keeps Side capability optional for older daemons", () => {
    const payload = { status: "server_info", serverId: "host-1", hostname: null, version: null };
    expect(ServerInfoStatusPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...payload, features: { sideChat: true } }),
    ).toEqual({ ...payload, features: { sideChat: true } });
  });
});
