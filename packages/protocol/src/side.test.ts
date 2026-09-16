import { describe, expect, it, test } from "vitest";
import {
  SideChatSnapshotSchema,
  SideChatSendRequestSchema,
  SideChatChangedEventSchema,
  SideChatSteerRequestSchema,
  SideChatResetRequestSchema,
} from "./side.js";

const legacy = {
  mainAgentId: "main",
  sideAgentId: null,
  status: "idle",
  error: null,
  messages: [],
  steeringProposal: null,
};
describe("Side wire compatibility", () => {
  it("continues accepting old snapshots and send requests", () => {
    expect(SideChatSnapshotSchema.parse(legacy)).toEqual(legacy);
    expect(
      SideChatSendRequestSchema.parse({
        type: "agent.side.send.request",
        requestId: "request",
        mainAgentId: "main",
        text: "Question",
      }).text,
    ).toBe("Question");
  });
  it("validates bounded references and stable request identities", () => {
    const reference = {
      id: "quote",
      kind: "selection",
      label: "Selected code",
      text: "exact selection",
      agentId: "main",
    };
    const request = {
      type: "agent.side.send.request",
      requestId: "request",
      mainAgentId: "main",
      text: "Verify",
      clientMessageId: "same-retry",
      action: "review",
      references: [reference],
    };
    expect(SideChatSendRequestSchema.parse(request).references).toEqual([reference]);
    expect(
      SideChatSendRequestSchema.safeParse({ ...request, references: Array(5).fill(reference) })
        .success,
    ).toBe(false);
    expect(
      SideChatSendRequestSchema.safeParse({
        ...request,
        references: [{ ...reference, text: "x".repeat(12001) }],
      }).success,
    ).toBe(false);
  });
  it("allows empty upserts for main freshness updates without clearing messages", () => {
    const event = SideChatChangedEventSchema.parse({
      type: "agent.side.changed",
      payload: { ...legacy, revision: 3, conversationId: "conversation" },
    });
    expect(event.payload.messages).toEqual([]);
    expect(event.payload.revision).toBe(3);
  });
  it("rejects unsafe steering/reset identities and oversized instructions", () => {
    expect(
      SideChatSteerRequestSchema.safeParse({
        type: "agent.side.steer.request",
        requestId: "r",
        mainAgentId: "main",
        proposalId: "",
        text: "Run tests",
      }).success,
    ).toBe(false);
    expect(
      SideChatSteerRequestSchema.safeParse({
        type: "agent.side.steer.request",
        requestId: "r",
        mainAgentId: "main",
        proposalId: "proposal",
        text: "x".repeat(32001),
      }).success,
    ).toBe(false);
    expect(
      SideChatResetRequestSchema.safeParse({
        type: "agent.side.reset.request",
        requestId: "r",
        mainAgentId: "main",
        conversationId: "",
      }).success,
    ).toBe(false);
  });
});

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

describe("Side v2 routing", () => {
  it.each([
    ["subscribe", { subscribed: true }],
    ["reset", { conversationId: "conversation" }],
    ["steer", { proposalId: "proposal", text: "Run tests" }],
  ])("routes %s requests and responses through the shared protocol", (operation, extra) => {
    const request = {
      type: `agent.side.${operation}.request`,
      requestId: "request",
      mainAgentId: "main",
      ...extra,
    };
    expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
    const response = {
      type: `agent.side.${operation}.response`,
      payload: { requestId: "request", chat, error: null },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
    expect(validateWSOutboundMessage({ type: "session", message: response }).success).toBe(true);
  });
  it("routes pushed upserts through the outbound AOT validator", () => {
    const event = {
      type: "agent.side.changed",
      payload: { ...chat, conversationId: "conversation", revision: 1 },
    };
    expect(SessionOutboundMessageSchema.parse(event)).toEqual(event);
    expect(validateWSOutboundMessage({ type: "session", message: event }).success).toBe(true);
  });
});
