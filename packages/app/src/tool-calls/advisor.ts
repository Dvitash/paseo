import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdvisorToolCallCandidate {
  detail?: ToolCallDetail | null;
  metadata?: Record<string, unknown> | null;
}

export interface ParsedAdvisorComment {
  id: string;
  severity: AdvisorSeverity | "neutral";
  advisor?: string;
  text: string;
}

export function isAdvisorToolCall(candidate?: AdvisorToolCallCandidate | null): boolean {
  if (!candidate) return false;
  return candidate.metadata?.source === "omp_advisor" && candidate.detail?.type === "plain_text";
}

const SEVERITY_SPLIT_REGEX = /(?:\r?\n\s*){2,}(?=\s*\[(?:nit|concern|blocker)\])/i;
const SEVERITY_PREFIX_REGEX = /^\s*\[(nit|concern|blocker)\](?:\s+\[([^\]]+)\])?\s*([\s\S]*)$/i;

export function parseAdvisorComments(rawText: string | undefined | null): ParsedAdvisorComment[] {
  if (!rawText || !rawText.trim()) {
    return [];
  }

  const trimmed = rawText.trim();
  const chunks = trimmed.split(SEVERITY_SPLIT_REGEX);

  return chunks.map((chunk, index) => {
    const match = chunk.match(SEVERITY_PREFIX_REGEX);
    if (match) {
      const rawSeverity = match[1].toLowerCase();
      const severity: AdvisorSeverity =
        rawSeverity === "concern" || rawSeverity === "blocker" ? rawSeverity : "nit";
      const advisor = match[2]?.trim() || undefined;
      const text = match[3]?.trim() ?? "";
      return {
        id: `advisor-comment-${index}`,
        severity,
        advisor,
        text,
      };
    }

    return {
      id: `advisor-comment-${index}`,
      severity: "neutral",
      text: chunk.trim(),
    };
  });
}

export function getAdvisorSeverityLabel(severity: AdvisorSeverity | "neutral"): string {
  switch (severity) {
    case "nit":
      return "Nit";
    case "concern":
      return "Concern";
    case "blocker":
      return "Blocker";
    case "neutral":
      return "Note";
  }
}
