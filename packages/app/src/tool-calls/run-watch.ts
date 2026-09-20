import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

const GITHUB_BRIDGE_PATH = "xd://github";

export interface RunWatchToolCall {
  repo: string;
  repoName: string;
  branch: string;
  tail?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRunWatchToolCall(
  detail: ToolCallDetail | undefined,
): RunWatchToolCall | null {
  if (detail?.type !== "write" || detail.filePath !== GITHUB_BRIDGE_PATH) {
    return null;
  }

  const content = detail.content?.trim();
  if (!content) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    return null;
  }

  if (!isRecord(payload) || payload.op !== "run_watch") {
    return null;
  }

  const repo = typeof payload.repo === "string" ? payload.repo.trim() : "";
  const branch = typeof payload.branch === "string" ? payload.branch.trim() : "";
  if (!repo || !branch) {
    return null;
  }

  const repoSegments = repo.split("/").filter(Boolean);
  const repoName = repoSegments[repoSegments.length - 1] ?? repo;
  const tail =
    typeof payload.tail === "number" && Number.isFinite(payload.tail) ? payload.tail : undefined;

  return {
    repo,
    repoName,
    branch,
    ...(tail !== undefined ? { tail } : {}),
  };
}
