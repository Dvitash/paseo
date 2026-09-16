import type { ToolCallTimelineItem } from "./agent-types.js";
import { getPaseoToolLeafName, isPaseoToolName } from "./tool-name-normalization.js";
import { stripCwdPrefix } from "./path-utils.js";

export type ToolCallDisplayInput = Pick<
  ToolCallTimelineItem,
  "name" | "status" | "error" | "metadata" | "detail"
> & {
  cwd?: string;
};

export interface ToolCallDisplayModel {
  displayName: string;
  summary?: string;
  errorText?: string;
}

interface DetailDisplay {
  displayName?: string;
  summary?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function humanizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return name;
  }
  if (isPaseoToolName(trimmed)) {
    const leaf = getPaseoToolLeafName(trimmed);
    if (leaf) {
      return humanizeToolName(leaf);
    }
  }
  if (/[:./]/.test(trimmed) || trimmed.includes("__")) {
    return trimmed;
  }

  return trimmed
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter((segment) => segment.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/^./, (character) => character.toUpperCase());
}

function readTextErrorEnvelope(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;

  // Only unwrap text-only transport envelopes. Keep diagnostic fields and
  // unfamiliar content blocks in the fallback instead of silently losing them.
  const hasExtraFields = Object.keys(error).some(
    (key) => key !== "content" && key !== "details" && key !== "isError",
  );
  if (hasExtraFields) return undefined;
  if (error.isError !== undefined && typeof error.isError !== "boolean") return undefined;
  if (error.details !== undefined && error.details !== null) {
    if (!isRecord(error.details) || Object.keys(error.details).length > 0) return undefined;
  }
  if (typeof error.content === "string") return readString(error.content);
  if (!Array.isArray(error.content) || error.content.length === 0) return undefined;

  const texts: string[] = [];
  for (const block of error.content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      return undefined;
    }
    if (Object.keys(block).some((key) => key !== "type" && key !== "text")) return undefined;
    texts.push(block.text);
  }
  const text = texts.join("\n");
  return text.trim() ? text : undefined;
}

function formatErrorText(error: unknown): string | undefined {
  if (error === null || error === undefined) {
    return undefined;
  }
  if (typeof error === "string") {
    if (!error.trimStart().startsWith("{")) return error;
    try {
      const parsed: unknown = JSON.parse(error);
      return readTextErrorEnvelope(parsed) ?? error;
    } catch {
      return error;
    }
  }
  const text = readTextErrorEnvelope(error);
  if (text !== undefined) return text;
  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return String(error);
  }
}

function buildFilePathDisplay(
  displayName: string,
  filePath: string,
  cwd: string | undefined,
): DetailDisplay {
  return {
    displayName,
    summary: stripCwdPrefix(filePath, cwd),
  };
}

function buildCanonicalDetailDisplay(input: ToolCallDisplayInput): DetailDisplay {
  switch (input.detail.type) {
    case "shell":
      return {
        displayName: "Shell",
        summary: input.detail.command,
      };
    case "read":
      return buildFilePathDisplay("Read", input.detail.filePath, input.cwd);
    case "edit":
      return buildFilePathDisplay("Edit", input.detail.filePath, input.cwd);
    case "write":
      return buildFilePathDisplay("Write", input.detail.filePath, input.cwd);
    case "search":
      return {
        displayName: "Search",
        summary: input.detail.query,
      };
    case "fetch":
      return {
        displayName: "Fetch",
        summary: input.detail.url,
      };
    case "worktree_setup":
      return {
        displayName: "Worktree setup",
        summary: input.detail.branchName,
      };
    case "sub_agent":
      return {
        displayName: readString(input.detail.subAgentType) ?? "Task",
        summary: readString(input.detail.description),
      };
    case "plain_text":
      return {
        summary: input.detail.label,
      };
    case "plan":
      return {
        displayName: "Plan",
      };
    case "unknown":
      return {};
    default:
      throw new Error("unreachable");
  }
}

function buildUnknownDetailOverride(input: ToolCallDisplayInput): DetailDisplay {
  const lowerName = input.name.trim().toLowerCase();
  if (input.detail.type === "unknown" && lowerName === "task") {
    return {
      displayName: "Task",
      summary: isRecord(input.metadata) ? readString(input.metadata.subAgentActivity) : undefined,
    };
  }
  if (input.detail.type === "unknown" && lowerName === "thinking") {
    return {
      displayName: "Thinking",
    };
  }
  if (lowerName === "terminal") {
    return {
      displayName: "Terminal",
      summary: input.detail.type === "plain_text" ? readString(input.detail.label) : undefined,
    };
  }
  return {};
}

export function buildToolCallDisplayModel(input: ToolCallDisplayInput): ToolCallDisplayModel {
  const canonicalDisplay = buildCanonicalDetailDisplay(input);
  const unknownDetailOverride = buildUnknownDetailOverride(input);
  const displayName =
    unknownDetailOverride.displayName ??
    canonicalDisplay.displayName ??
    humanizeToolName(input.name);
  const summary = unknownDetailOverride.summary ?? canonicalDisplay.summary;
  const errorText = input.status === "failed" ? formatErrorText(input.error) : undefined;

  return {
    displayName,
    ...(summary ? { summary } : {}),
    ...(errorText ? { errorText } : {}),
  };
}
