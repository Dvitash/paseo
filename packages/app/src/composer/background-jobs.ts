import type { StreamItem, ToolCallItem } from "@/types/stream";

export interface BackgroundJobWaitCall {
  id: string;
  label: string;
  status: string;
  timestamp: Date;
}

const BACKGROUND_JOB_ID_PATTERN = "bg_[A-Za-z0-9_-]+";
const EXACT_WAIT_PATTERN = new RegExp(
  `^(?:waiting\\s+for|wait(?:ing)?\\s+on)\\s+(${BACKGROUND_JOB_ID_PATTERN})(?:\\s*(?:\\.{1,3}|…))?$`,
  "i",
);
const WAIT_TOOL_NAME_PATTERN = /(?:^|[_\s-])(wait|await)(?:$|[_\s-])|background[_\s-]?output|task[_\s-]?(?:output|wait)/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function textWaitCall(item: StreamItem, jobId: string): BackgroundJobWaitCall | null {
  if (item.kind !== "assistant_message" && item.kind !== "thought" && item.kind !== "notification") {
    return null;
  }
  const text = (item.kind === "notification" ? item.message : item.text).trim();
  const jobPattern = new RegExp(
    `\\b(?:waiting\\s+for|wait(?:ing)?\\s+on)\\s+${escapeRegExp(jobId)}\\b`,
    "i",
  );
  if (!jobPattern.test(text)) return null;
  return {
    id: item.id,
    label: text,
    status: item.kind === "thought" && item.status === "loading" ? "running" : "completed",
    timestamp: item.timestamp,
  };
}

function toolCallWaitCall(item: ToolCallItem, jobId: string): BackgroundJobWaitCall | null {
  const data = item.payload.data;
  const name = item.payload.source === "agent" ? data.name : data.toolName;
  if (!WAIT_TOOL_NAME_PATTERN.test(name)) return null;

  const searchable = safeSerialize(data);
  if (!searchable.toLowerCase().includes(jobId.toLowerCase())) return null;

  return {
    id: item.id,
    label: name,
    status: data.status,
    timestamp: item.startedAt ?? item.timestamp,
  };
}

/**
 * Finds explicit waits for one provider-owned background job. Tool calls are preferred because
 * providers often also emit a human-readable "Waiting for bg_X" row for the same wait.
 */
export function collectBackgroundJobWaitCalls(
  items: readonly StreamItem[] | undefined,
  jobId: string,
): BackgroundJobWaitCall[] {
  if (!items?.length || !jobId) return [];

  const toolCalls = items
    .map((item) => (item.kind === "tool_call" ? toolCallWaitCall(item, jobId) : null))
    .filter((item): item is BackgroundJobWaitCall => item !== null);
  if (toolCalls.length > 0) return toolCalls;

  return items
    .map((item) => textWaitCall(item, jobId))
    .filter((item): item is BackgroundJobWaitCall => item !== null);
}

/** Exact provider chatter that is redundant once background jobs have their own status pills. */
export function isBackgroundJobWaitChatter(item: StreamItem): boolean {
  if (item.kind !== "assistant_message" && item.kind !== "thought" && item.kind !== "notification") {
    return false;
  }
  const text = (item.kind === "notification" ? item.message : item.text).trim();
  return EXACT_WAIT_PATTERN.test(text);
}

export function omitBackgroundJobWaitChatter(items: StreamItem[]): StreamItem[] {
  if (!items.some(isBackgroundJobWaitChatter)) return items;
  return items.filter((item) => !isBackgroundJobWaitChatter(item));
}

export function shouldCollapseBackgroundJobs(input: {
  count: number;
  availableWidth: number | null;
  compact: boolean;
}): boolean {
  if (input.count <= 1) return false;
  if (input.count >= 4 || input.compact) return true;
  if (input.availableWidth === null) return false;

  // Individual pills average ~200px once id, wait count and elapsed time are present. Keep a
  // small reserve so the neighboring composer pills do not get forced off-screen.
  const requiredWidth = input.count * 200 + (input.count - 1) * 4 + 32;
  return input.availableWidth < requiredWidth;
}
