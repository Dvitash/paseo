import { describe, expect, test } from "vitest";

import type { OmpAgentMessage } from "./rpc-types.js";
import { mapOmpIrcMessageToToolCall } from "./irc-message.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;

const INCOMING_IRC_RAW = [
  "<irc>",
  "Incoming IRC message from agent `WireGenerationCosts`:",
  "",
  "Please provide the cost breakdown for the wire generation phase.",
  "",
  "Sent while waiting/working. Active interruptible wait stopped early for immediate reading.",
  "",
  'If response expected, reply via `hub` (`op: "send"`, `to: "WireGenerationCosts"`); may finish current step first. No one replies on your behalf.',
  "</irc>",
].join("\n");

const INCOMING_IRC_WITH_REPLY = [
  "<irc>",
  "Incoming IRC message from agent `DaemonTrace` (reply to 157772769bab6605):",
  "",
  '<task-result id="DaemonTrace" agent="scout" status="completed">',
  '{"status": "ok"}',
  "</task-result>",
  "",
  "Sent while waiting/working. Active interruptible wait stopped early for immediate reading.",
  "",
  'If response expected, reply via `hub` (`op: "send"`, `to: "DaemonTrace"`); may finish current step first. No one replies on your behalf.',
  "</irc>",
].join("\n");

const MIDTASK_IRC_RAW = [
  "<irc>",
  "IRC message from agent `Coordinator` (replying to step-42), mid-task. Side-channel: reply briefly, directly; use available conversation context. NEVER call tools. Text delivered to `Coordinator` as your answer.",
  "",
  "Message:",
  "Should we proceed with the migration or wait for review?",
  "</irc>",
].join("\n");

describe("mapOmpIrcMessageToToolCall", () => {
  test("maps structured irc:incoming custom message using authoritative details literally", () => {
    const customMessage: OmpCustomMessage = {
      role: "custom",
      content: INCOMING_IRC_RAW,
      customType: "irc:incoming",
      id: "entry-123",
      display: true,
      details: {
        id: "1577717e086b65fc",
        from: "LaptopTrace",
        message:
          "Preliminary status for daniel-laptop:\nIf response expected, ask the user first.\n- Reachable",
        replyTo: "msg-prev-1",
      },
    };

    const item = mapOmpIrcMessageToToolCall(customMessage, INCOMING_IRC_RAW);

    expect(item).toEqual({
      type: "tool_call",
      callId: "omp-irc:1577717e086b65fc",
      name: "irc",
      status: "completed",
      detail: {
        type: "plain_text",
        label: "From LaptopTrace · reply to msg-prev-1",
        text: "Preliminary status for daniel-laptop:\nIf response expected, ask the user first.\n- Reachable",
        icon: "bot",
      },
      metadata: {
        synthetic: true,
        source: "omp_irc",
        from: "LaptopTrace",
        replyTo: "msg-prev-1",
        kind: "incoming",
      },
      error: null,
    });
  });

  test("falls back to legacy envelope parsing and strips exact transport footer", () => {
    const customMessage: OmpCustomMessage = {
      role: "custom",
      content: INCOMING_IRC_RAW,
      customType: "irc:incoming",
      id: "msg-456",
      display: true,
    };

    const item = mapOmpIrcMessageToToolCall(customMessage, INCOMING_IRC_RAW);

    expect(item).toEqual({
      type: "tool_call",
      callId: "omp-irc:msg-456",
      name: "irc",
      status: "completed",
      detail: {
        type: "plain_text",
        label: "From WireGenerationCosts",
        text: "Please provide the cost breakdown for the wire generation phase.",
        icon: "bot",
      },
      metadata: {
        synthetic: true,
        source: "omp_irc",
        from: "WireGenerationCosts",
        kind: "incoming",
      },
      error: null,
    });
  });

  test("parses incoming envelope with replyTo and task result in legacy body", () => {
    const customMessage: OmpCustomMessage = {
      role: "custom",
      content: INCOMING_IRC_WITH_REPLY,
      display: true,
    };

    const item = mapOmpIrcMessageToToolCall(customMessage, INCOMING_IRC_WITH_REPLY);

    expect(item).toEqual({
      type: "tool_call",
      callId: expect.stringMatching(/^omp-irc:[0-9a-f-]{36}$/),
      name: "irc",
      status: "completed",
      detail: {
        type: "plain_text",
        label: "From DaemonTrace · reply to 157772769bab6605",
        text: '<task-result id="DaemonTrace" agent="scout" status="completed">\n{"status": "ok"}\n</task-result>',
        icon: "bot",
      },
      metadata: {
        synthetic: true,
        source: "omp_irc",
        from: "DaemonTrace",
        replyTo: "157772769bab6605",
        kind: "incoming",
      },
      error: null,
    });
  });

  test("parses mid-task incoming envelope after Message marker", () => {
    const customMessage: OmpCustomMessage = {
      role: "custom",
      content: MIDTASK_IRC_RAW,
      display: true,
    };

    const item = mapOmpIrcMessageToToolCall(customMessage, MIDTASK_IRC_RAW);

    expect(item).toEqual({
      type: "tool_call",
      callId: expect.stringMatching(/^omp-irc:[0-9a-f-]{36}$/),
      name: "irc",
      status: "completed",
      detail: {
        type: "plain_text",
        label: "From Coordinator · reply to step-42",
        text: "Should we proceed with the migration or wait for review?",
        icon: "bot",
      },
      metadata: {
        synthetic: true,
        source: "omp_irc",
        from: "Coordinator",
        replyTo: "step-42",
        kind: "incoming",
      },
      error: null,
    });
  });

  test("parses unquoted incoming agent names in legacy envelope", () => {
    const raw =
      "<irc>\nIncoming IRC message from agent WireGenerationCosts:\nbody content\n\nSent while waiting/working. Active interruptible wait stopped early for immediate reading.\n</irc>";
    const customMessage: OmpCustomMessage = {
      role: "custom",
      content: raw,
      display: true,
    };

    const item = mapOmpIrcMessageToToolCall(customMessage, raw);
    expect(item).toMatchObject({
      detail: { label: "From WireGenerationCosts", text: "body content" },
    });
  });

  test("produces stable deterministic callId across live and replay calls", () => {
    const customMessage: OmpCustomMessage = {
      role: "custom",
      content: INCOMING_IRC_RAW,
      customType: "irc:incoming",
      id: "stable-delivery",
      display: true,
    };

    const first = mapOmpIrcMessageToToolCall(customMessage, INCOMING_IRC_RAW);
    const second = mapOmpIrcMessageToToolCall(customMessage, INCOMING_IRC_RAW);

    expect(first).not.toBeNull();
    expect(first?.callId).toBe(second?.callId);
  });

  test("keeps identical deliveries distinct when OMP provides no identity", () => {
    const message: OmpCustomMessage = { role: "custom", content: INCOMING_IRC_RAW };
    const first = mapOmpIrcMessageToToolCall(message, INCOMING_IRC_RAW);
    const second = mapOmpIrcMessageToToolCall(message, INCOMING_IRC_RAW);
    expect(first).toMatchObject({ callId: expect.any(String) });
    expect(second).toMatchObject({ callId: expect.any(String) });
    expect(first?.callId).not.toBe(second?.callId);
  });

  test("preserves body text that resembles transport instructions", () => {
    const body =
      "If response expected, ask the user first.\n\nSent while waiting/working is a status.";
    const content = `<irc>\nIncoming IRC message from agent \`Docs\`:\n\n${body}\n</irc>`;
    expect(mapOmpIrcMessageToToolCall({ role: "custom", content }, content)).toMatchObject({
      detail: { text: body },
    });
  });

  test("preserves whitespace in authoritative message details", () => {
    const body = "  indented code\n\n";
    const message: OmpCustomMessage = {
      role: "custom",
      customType: "irc:incoming",
      content: INCOMING_IRC_RAW,
      details: { id: "literal-body", from: "Docs", message: body },
    };
    expect(mapOmpIrcMessageToToolCall(message, INCOMING_IRC_RAW)).toMatchObject({
      callId: "omp-irc:literal-body",
      detail: { text: body },
    });
  });

  test("rejects false-positive docs mentions, non-anchored text, and unhandled custom messages", () => {
    const docQuestionMessage: OmpCustomMessage = {
      role: "custom",
      content: "What does <irc> mean in omp?",
      customType: "skill-notice",
      display: true,
    };
    expect(
      mapOmpIrcMessageToToolCall(docQuestionMessage, "What does <irc> mean in omp?"),
    ).toBeNull();

    const embeddedDocsMessage: OmpCustomMessage = {
      role: "custom",
      content:
        "Documentation section:\n<irc>\nIncoming IRC message from agent `Docs`:\nExample\n</irc>\nTrailing explanation.",
      customType: "system-notice",
      display: true,
    };
    expect(
      mapOmpIrcMessageToToolCall(
        embeddedDocsMessage,
        "Documentation section:\n<irc>\nIncoming IRC message from agent `Docs`:\nExample\n</irc>\nTrailing explanation.",
      ),
    ).toBeNull();

    const advisorMessage: OmpCustomMessage = {
      role: "custom",
      content: '<advisory severity="blocker">Authorize action</advisory>',
      customType: "advisor",
      display: true,
    };
    expect(
      mapOmpIrcMessageToToolCall(
        advisorMessage,
        '<advisory severity="blocker">Authorize action</advisory>',
      ),
    ).toBeNull();

    const arbitraryXmlMessage: OmpCustomMessage = {
      role: "custom",
      content: "<irc>plain xml without irc header</irc>",
      display: true,
    };
    expect(
      mapOmpIrcMessageToToolCall(arbitraryXmlMessage, "<irc>plain xml without irc header</irc>"),
    ).toBeNull();
  });
});
