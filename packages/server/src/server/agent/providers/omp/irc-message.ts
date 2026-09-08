import { randomUUID } from "node:crypto";

import type { AgentTimelineItem } from "../../agent-sdk-types.js";
import type { OmpAgentMessage } from "./rpc-types.js";

type OmpCustomMessage = Extract<OmpAgentMessage, { role: "custom" }>;
type OmpIrcToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

const INCOMING_HEADER_PATTERN =
  /^Incoming IRC message from agent [`"']?([A-Za-z0-9_.:-]+)[`"']?(?:\s*\((?:reply|replying)\s+to\s+([^)]+)\))?:\s*/i;

const MIDTASK_HEADER_PATTERN =
  /^IRC message from agent [`"']?([A-Za-z0-9_.:-]+)[`"']?(?:\s*\((?:reply|replying)\s+to\s+([^)]+)\))?,\s*mid-task\b[\s\S]*?\bMessage:\s*/i;

const REPLY_FOOTER_PATTERN =
  /\n\nIf response expected, reply via `hub` \(`op: "send"`, `to: "[^"\n]+"`\); may finish current step first\. No one replies on your behalf\.$/;
const WAIT_FOOTER =
  "\n\nSent while waiting/working. Active interruptible wait stopped early for immediate reading.";

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripTrailingTransportFooter(text: string): string {
  const withoutReply = text.trimEnd().replace(REPLY_FOOTER_PATTERN, "");
  const body = withoutReply.endsWith(WAIT_FOOTER)
    ? withoutReply.slice(0, -WAIT_FOOTER.length)
    : withoutReply;
  return body.trim();
}

function isAnchoredIrcEnvelope(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<irc>") && trimmed.endsWith("</irc>");
}

interface ExtractedIrc {
  from: string;
  replyTo?: string;
  body: string;
  id?: string;
}

function extractLegacyEnvelope(text: string): ExtractedIrc | null {
  if (!isAnchoredIrcEnvelope(text)) {
    return null;
  }
  const inner = text.trim().slice(5, -6).trim();

  const incomingMatch = inner.match(INCOMING_HEADER_PATTERN);
  if (incomingMatch) {
    const rawBody = inner.slice(incomingMatch[0].length);
    return {
      from: incomingMatch[1],
      replyTo: readOptionalString(incomingMatch[2]),
      body: stripTrailingTransportFooter(rawBody),
    };
  }

  const midtaskMatch = inner.match(MIDTASK_HEADER_PATTERN);
  if (midtaskMatch) {
    const rawBody = inner.slice(midtaskMatch[0].length);
    return {
      from: midtaskMatch[1],
      replyTo: readOptionalString(midtaskMatch[2]),
      body: stripTrailingTransportFooter(rawBody),
    };
  }

  return null;
}

function extractIncomingIrc(message: OmpCustomMessage, text: string): ExtractedIrc | null {
  const details = Reflect.get(message, "details");
  if (details && typeof details === "object") {
    const from = readOptionalString(Reflect.get(details, "from"));
    const detailsMessage = Reflect.get(details, "message");
    if (from && typeof detailsMessage === "string" && detailsMessage.trim()) {
      return {
        from,
        replyTo: readOptionalString(Reflect.get(details, "replyTo")),
        body: detailsMessage,
        id: readOptionalString(Reflect.get(details, "id")),
      };
    }
  }

  return extractLegacyEnvelope(text);
}

function buildIrcCallId(message: OmpCustomMessage, id?: string): string {
  if (id) return `omp-irc:${id}`;
  const messageId = readOptionalString(Reflect.get(message, "id"));
  if (messageId) return `omp-irc:${messageId}`;
  // Identical deliveries are distinct messages when OMP supplies no native identity.
  return `omp-irc:${randomUUID()}`;
}

export function mapOmpIrcMessageToToolCall(
  message: OmpCustomMessage,
  text: string,
): OmpIrcToolCallItem | null {
  const customType = Reflect.get(message, "customType");
  const isIncoming = customType === "irc:incoming";
  if (!isIncoming && !isAnchoredIrcEnvelope(text)) {
    return null;
  }

  const extracted = extractIncomingIrc(message, text);
  if (!extracted || !extracted.body) {
    return null;
  }

  const label = extracted.replyTo
    ? `From ${extracted.from} · reply to ${extracted.replyTo}`
    : `From ${extracted.from}`;

  return {
    type: "tool_call",
    callId: buildIrcCallId(message, extracted.id),
    name: "irc",
    status: "completed",
    detail: {
      type: "plain_text",
      label,
      text: extracted.body,
      icon: "bot",
    },
    metadata: {
      synthetic: true,
      source: "omp_irc",
      from: extracted.from,
      ...(extracted.replyTo ? { replyTo: extracted.replyTo } : {}),
      kind: "incoming",
    },
    error: null,
  };
}
