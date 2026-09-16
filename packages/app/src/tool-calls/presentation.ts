import type { ComponentType } from "react";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { ToolCallDisplayInput } from "@/utils/tool-call-display";
import { i18n } from "@/i18n/i18next";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";
import { extractToolCallFilePath } from "@/utils/extract-tool-call-file-path";
import {
  hasMeaningfulToolCallDetail,
  isPendingToolCallDetail,
} from "@/utils/tool-call-detail-state";
import { getEvalPresentation, type EvalPresentation } from "./eval";
import { getHubPresentation, hasHubContent, type HubPresentation } from "./hub";

type ToolCallStatus = "executing" | "running" | "completed" | "failed" | "canceled";
export type ToolCallPresentationIcon = ComponentType<{ size?: number; color?: string }>;

interface BuildToolCallPresentationInput {
  toolName: string;
  status: ToolCallStatus;
  error: unknown;
  detail?: ToolCallDetail;
  cwd?: string;
  metadata?: Record<string, unknown>;
  resolveIcon: ToolCallIconResolver;
  /** Streamed-thinking token estimate; only the thinking badge renders it. */
  tokenCount?: number;
}

export interface ToolCallPresentation {
  displayName: string;
  summary?: string;
  errorText?: string;
  icon: ToolCallPresentationIcon;
  isLoadingDetails: boolean;
  hasDetails: boolean;
  canOpenDetails: boolean;
  openFilePath: string | null;
  isPlan: boolean;
  evaluation: EvalPresentation | null;
  hub: HubPresentation | null;
  hasPreview: boolean;
}

export type ToolCallIconResolver = (
  toolName: string,
  detail: ToolCallDetail | undefined,
) => ToolCallPresentationIcon;

function displayStatus(status: ToolCallStatus): ToolCallDisplayInput["status"] {
  return status === "executing" ? "running" : status;
}

function displayDetail(detail: ToolCallDetail | undefined): ToolCallDetail {
  return detail ?? { type: "unknown", input: null, output: null };
}

function hasFilePreview(detail: ToolCallDetail | undefined): boolean {
  if (!detail) return false;
  if (detail.type === "write") {
    return !detail.filePath.startsWith("xd://") && Boolean(detail.content);
  }
  if (detail.type === "edit") {
    return Boolean(detail.unifiedDiff || detail.oldString || detail.newString);
  }
  return false;
}

export function buildToolCallPresentation(
  input: BuildToolCallPresentationInput,
): ToolCallPresentation {
  const detailForDisplay = displayDetail(input.detail);
  const displayModel = buildToolCallDisplayModel({
    name: input.toolName,
    status: displayStatus(input.status),
    error: input.error ?? null,
    detail: detailForDisplay,
    metadata: input.metadata,
    cwd: input.cwd,
  });
  const isLoadingDetails = isPendingToolCallDetail({
    detail: input.detail,
    status: input.status,
    error: input.error,
  });
  const hasDetails = Boolean(input.error) || hasMeaningfulToolCallDetail(input.detail);
  const evaluation = getEvalPresentation(input.toolName, input.detail, input.error);
  const hub = getHubPresentation(input.toolName, input.detail, input.status);
  // Hub owns this error in both the preview and details. Only suppress an exact
  // duplicate of its dedicated error block; distinct diagnostics remain visible.
  const hubError = hub?.blocks.length === 1 ? hub.blocks[0] : undefined;
  const errorIsRenderedByHub =
    hubError?.id === "hub-error" &&
    Boolean(displayModel.errorText?.trim()) &&
    hubError.text.trim() === displayModel.errorText?.trim();
  const errorText = errorIsRenderedByHub ? undefined : displayModel.errorText;
  // The thinking badge counts streamed reasoning as a live progress signal.
  // The count itself is the caller's ~4 chars-per-token estimate; the daemon
  // sends no per-delta token counts.
  const thinkingTokenSummary =
    input.toolName === "thinking" && input.tokenCount
      ? i18n.t("message.thinking.tokens", { tokens: input.tokenCount.toLocaleString() })
      : undefined;

  return {
    displayName: displayModel.displayName,
    summary: evaluation?.title ?? hub?.summary ?? displayModel.summary ?? thinkingTokenSummary,
    errorText,
    icon: input.resolveIcon(input.toolName, input.detail),
    isLoadingDetails,
    hasDetails,
    canOpenDetails: hasDetails || isLoadingDetails,
    openFilePath: extractToolCallFilePath(input.detail),
    isPlan: input.detail?.type === "plan",
    evaluation,
    hub,
    hasPreview: evaluation !== null || hasHubContent(hub) || hasFilePreview(input.detail),
  };
}
