import type { TFunction } from "i18next";
import type { ComposerTrackPillSegment } from "@/composer/tracks";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { deriveSidebarStateBucket, STATUS_BUCKET_ORDER } from "@/utils/sidebar-agent-state";
import type { SubagentRow } from "./select";
import { isFinishedSubagent } from "./archive-finished";
import { providerSubagentLifecycleStatus } from "./provider-store";

function presentationStatus(row: SubagentRow) {
  if (row.kind === "paseo") {
    if (row.turn.phase === "open") return "running";
    return row.status === "running" ? "idle" : row.status;
  }
  return providerSubagentLifecycleStatus(row.status);
}

export interface SubagentRowPresentationData {
  key: string;
  kind: "agent";
  label: string;
  subtitle: string;
  titleState: "ready" | "loading";
  statusBucket: SidebarStateBucket | null;
}

export function buildSubagentRowPresentationData(row: SubagentRow): SubagentRowPresentationData {
  const description = resolveRowLabel(row.description);
  const title = resolveRowLabel(row.title);
  const label = description ?? title;
  const providerSubtitle = row.kind === "provider" ? resolveRowLabel(row.subtitle) : null;
  const subtitle = providerSubtitle ?? (description ? title : null);
  const status = presentationStatus(row);
  return {
    key: `${row.kind}_subagent_${row.id}`,
    kind: "agent",
    label: label ?? "",
    subtitle: subtitle ?? "",
    titleState: label ? "ready" : "loading",
    statusBucket: deriveSidebarStateBucket({
      status,
      requiresAttention: false,
    }),
  };
}

type ActiveStatusBucket = Exclude<SidebarStateBucket, "done">;

const ACTIVE_STATUS_BUCKET_ORDER = STATUS_BUCKET_ORDER.filter(
  (bucket): bucket is ActiveStatusBucket => bucket !== "done",
);

interface SubagentStatusCount {
  bucket: ActiveStatusBucket;
  count: number;
}

export interface SubagentPillPresentation {
  segments: ComposerTrackPillSegment[];
  accessibilityLabel: string;
}

export function buildSubagentPillPresentation(
  t: TFunction,
  rows: readonly SubagentRow[],
): SubagentPillPresentation {
  const counts = summarizeSubagentStatus(rows);
  if (counts.length === 0) {
    const label = totalLabel(t, rows.length);
    return { segments: [{ bucket: null, text: label }], accessibilityLabel: label };
  }
  const labels = counts.map(({ bucket, count }) => statusLabel(t, bucket, count));
  return {
    segments: counts.map(({ bucket }, index) => ({ bucket, text: labels[index] ?? "" })),
    accessibilityLabel: labels.join(", "),
  };
}

function statusLabel(t: TFunction, bucket: ActiveStatusBucket, count: number): string {
  switch (bucket) {
    case "running":
      return t("subagents.pillLabelWorking", { count });
    case "failed":
      return t("subagents.pillLabelFailed", { count });
    case "needs_input":
      return count === 1
        ? t("subagents.pillLabelNeedsInputOne")
        : t("subagents.pillLabelNeedsInputMany", { count });
    case "attention":
      return t("subagents.pillLabelReadyToReview", { count });
  }
}

function totalLabel(t: TFunction, total: number): string {
  return total === 1 ? t("subagents.pillLabelOne") : t("subagents.pillLabelMany", { count: total });
}

function summarizeSubagentStatus(rows: readonly SubagentRow[]): SubagentStatusCount[] {
  const buckets = rows.map((row) => buildSubagentRowPresentationData(row).statusBucket);
  return ACTIVE_STATUS_BUCKET_ORDER.flatMap((bucket) => {
    const count = buckets.filter((candidate) => candidate === bucket).length;
    return count > 0 ? [{ bucket, count }] : [];
  });
}

export function countFinishedSubagents(rows: readonly SubagentRow[]): number {
  return rows.filter(isFinishedSubagent).length;
}

export function resolveRowLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized || normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

export interface RecentSubagentAction {
  id: string;
  name: string;
  status: string;
}

export function isSubagentActiveOrAttention(row: SubagentRow): boolean {
  if (row.requiresAttention || row.status === "error" || row.status === "failed") {
    return true;
  }
  if (row.kind === "paseo") {
    return row.turn.phase === "open" || row.status === "running";
  }
  return row.status === "running";
}

export function isSubagentCompleted(row: SubagentRow): boolean {
  return !isSubagentActiveOrAttention(row) && isFinishedSubagent(row);
}

export function sortSubagentRows(rows: readonly SubagentRow[]): SubagentRow[] {
  return [...rows].sort((a, b) => {
    const aActive = isSubagentActiveOrAttention(a);
    const bActive = isSubagentActiveOrAttention(b);
    if (aActive !== bActive) {
      return aActive ? -1 : 1;
    }
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

export function extractToolCallActivity(item: ToolCallItem): { name: string; status: string } {
  if (item.payload.source === "agent") {
    return {
      name: item.payload.data.name,
      status: item.payload.data.status,
    };
  }
  return {
    name: item.payload.data.toolName,
    status: item.payload.data.status,
  };
}

export function getLatestToolCallOrThought(
  items: readonly StreamItem[] | undefined,
): string | null {
  if (!items || items.length === 0) return null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "tool_call") {
      return extractToolCallActivity(item).name;
    }
    if (item.kind === "thought") {
      return "thinking";
    }
  }
  return null;
}

export function findLatestAssistantMessageText(
  items: readonly StreamItem[] | undefined,
): string | null {
  if (!items || items.length === 0) return null;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === "assistant_message") {
      const text = item.text.trim();
      if (text) return text;
    }
  }
  return null;
}

export function getRecentActions(
  items: readonly StreamItem[] | undefined,
  max = 3,
): RecentSubagentAction[] {
  if (!items || items.length === 0) return [];
  const actions: RecentSubagentAction[] = [];
  for (let i = items.length - 1; i >= 0 && actions.length < max; i -= 1) {
    const item = items[i];
    if (item.kind === "tool_call") {
      const { name, status } = extractToolCallActivity(item);
      actions.unshift({
        id: item.id,
        name,
        status,
      });
    }
  }
  return actions;
}
