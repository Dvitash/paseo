import type { StreamItem, ToolCallItem } from "@/types/stream";

export interface BackgroundJobSnapshot {
  id: string;
  startedAt: Date;
  lastSeenAt: Date;
}

const BACKGROUND_JOB_ID_SOURCE = "bg_[A-Za-z0-9_-]+";
const BACKGROUND_JOB_ID_PATTERN = new RegExp(`\\b${BACKGROUND_JOB_ID_SOURCE}\\b`, "gi");
const EXACT_WAIT_PATTERN = new RegExp(
  `^(?:waiting\\s+for|wait(?:ing)?\\s+on)\\s+(${BACKGROUND_JOB_ID_SOURCE})(?:\\s*(?:\\.{1,3}|…))?$`,
  "i",
);
const WAIT_TOOL_NAME_PATTERN =
  /(?:^|[_\s-])(wait|await)(?:$|[_\s-])|background[_\s-]?output|task[_\s-]?(?:output|wait)/i;
const TERMINAL_STATUS_PATTERN = /\b(completed|complete|failed|canceled|cancelled|done|exited|finished)\b/i;
const RUNNING_STATUS_PATTERN = /\b(running|in[_\s-]?progress|pending)\b/i;

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function itemText(item: StreamItem): string {
  if (item.kind === "assistant_message" || item.kind === "thought") return item.text;
  if (item.kind === "notification") return item.message;
  if (item.kind === "tool_call") return safeSerialize(item.payload.data);
  return "";
}

function toolCallName(item: ToolCallItem): string {
  const data = item.payload.data;
  return item.payload.source === "agent" ? data.name : data.toolName;
}

function toolCallStatus(item: ToolCallItem): string {
  return item.payload.data.status;
}

function contextAroundId(text: string, id: string): string {
  const lower = text.toLowerCase();
  const index = lower.indexOf(id.toLowerCase());
  if (index < 0) return text;
  return text.slice(Math.max(0, index - 140), Math.min(text.length, index + id.length + 180));
}

function mentionIsRunning(item: StreamItem, text: string, id: string): boolean | null {
  const context = contextAroundId(text, id);
  if (TERMINAL_STATUS_PATTERN.test(context)) return false;
  if (RUNNING_STATUS_PATTERN.test(context)) return true;
  if (item.kind === "tool_call") {
    const status = toolCallStatus(item);
    if (status === "running" || status === "executing") return true;
    if (status === "completed" || status === "failed" || status === "canceled") return false;
  }
  return null;
}

/**
 * Derive only background jobs that are currently running. Historical bg_* mentions are ignored;
 * each job's latest status-bearing mention wins.
 */
export function collectRunningBackgroundJobs(
  items: readonly StreamItem[] | undefined,
): BackgroundJobSnapshot[] {
  if (!items?.length) return [];

  const jobs = new Map<string, BackgroundJobSnapshot & { running: boolean }>();
  for (const item of items) {
    const text = itemText(item);
    if (!text) continue;
    const ids = text.match(BACKGROUND_JOB_ID_PATTERN) ?? [];
    for (const rawId of ids) {
      const id = rawId.toLowerCase();
      const running = mentionIsRunning(item, text, id);
      if (running === null) continue;
      const timestamp = item.startedAt ?? item.timestamp;
      const existing = jobs.get(id);
      jobs.set(id, {
        id,
        running,
        startedAt: running
          ? existing?.running
            ? existing.startedAt
            : timestamp
          : existing?.startedAt ?? timestamp,
        lastSeenAt: item.timestamp,
      });
    }
  }

  return [...jobs.values()]
    .filter((job) => job.running)
    .map(({ running: _running, ...job }) => job)
    .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
}

export function isWaitToolCall(item: StreamItem): item is ToolCallItem {
  return item.kind === "tool_call" && WAIT_TOOL_NAME_PATTERN.test(toolCallName(item));
}

/** Provider wait chatter is represented by the above-composer status pills instead. */
export function isBackgroundJobWaitChatter(item: StreamItem): boolean {
  if (isWaitToolCall(item)) return true;
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
