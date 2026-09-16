import type { StreamItem, ToolCallItem } from "@/types/stream";

export interface BackgroundJobSnapshot {
  id: string;
  startedAt: Date;
  lastSeenAt: Date;
  label: string | null;
}

const BACKGROUND_JOB_ID_SOURCE = "bg_[A-Za-z0-9_-]+";
const BACKGROUND_JOB_ID_PATTERN = new RegExp(`\\b${BACKGROUND_JOB_ID_SOURCE}\\b`, "gi");
const EXACT_WAIT_PATTERN = new RegExp(
  `^(?:waiting\\s+for|wait(?:ing)?\\s+on)\\s+(${BACKGROUND_JOB_ID_SOURCE})(?:\\s*(?:\\.{1,3}|…))?$`,
  "i",
);

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

function toolCallLabel(item: ToolCallItem): string | null {
  const data = item.payload.data;
  const name = item.payload.source === "agent" ? data.name : data.toolName;
  return name?.trim() || null;
}

/**
 * Provider background jobs are identified by their stable bg_* ids in the transcript/tool data.
 * They are intentionally independent from provider subagents, which have their own UI surface.
 */
export function collectBackgroundJobs(items: readonly StreamItem[] | undefined): BackgroundJobSnapshot[] {
  if (!items?.length) return [];

  const jobs = new Map<string, BackgroundJobSnapshot>();
  for (const item of items) {
    const text = itemText(item);
    if (!text) continue;
    const ids = text.match(BACKGROUND_JOB_ID_PATTERN) ?? [];
    for (const rawId of ids) {
      const id = rawId.toLowerCase();
      const timestamp = item.startedAt ?? item.timestamp;
      const existing = jobs.get(id);
      const label = item.kind === "tool_call" ? toolCallLabel(item) : null;
      if (!existing) {
        jobs.set(id, { id, startedAt: timestamp, lastSeenAt: item.timestamp, label });
        continue;
      }
      jobs.set(id, {
        ...existing,
        startedAt: existing.startedAt.getTime() <= timestamp.getTime() ? existing.startedAt : timestamp,
        lastSeenAt:
          existing.lastSeenAt.getTime() >= item.timestamp.getTime() ? existing.lastSeenAt : item.timestamp,
        label: existing.label ?? label,
      });
    }
  }

  return [...jobs.values()].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
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

  const requiredWidth = input.count * 150 + (input.count - 1) * 4 + 32;
  return input.availableWidth < requiredWidth;
}
