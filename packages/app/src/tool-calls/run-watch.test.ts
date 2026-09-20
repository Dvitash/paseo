import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";

import { parseRunWatchToolCall } from "./run-watch";

function writeDetail(content: string, filePath = "xd://github"): ToolCallDetail {
  return {
    type: "write",
    filePath,
    content,
  };
}

describe("parseRunWatchToolCall", () => {
  it("parses GitHub run_watch writes", () => {
    expect(
      parseRunWatchToolCall(
        writeDetail(
          JSON.stringify({
            op: "run_watch",
            repo: "Dvitash/RollOverEverything",
            branch: "dev",
            tail: 80,
          }),
        ),
      ),
    ).toEqual({
      repo: "Dvitash/RollOverEverything",
      repoName: "RollOverEverything",
      branch: "dev",
      tail: 80,
    });
  });

  it("rejects unrelated GitHub bridge operations", () => {
    expect(
      parseRunWatchToolCall(
        writeDetail(JSON.stringify({ op: "run", repo: "Dvitash/paseo", branch: "main" })),
      ),
    ).toBeNull();
  });

  it("rejects malformed payloads and non-GitHub writes", () => {
    expect(parseRunWatchToolCall(writeDetail("{not-json"))).toBeNull();
    expect(
      parseRunWatchToolCall(
        writeDetail(
          JSON.stringify({ op: "run_watch", repo: "Dvitash/paseo", branch: "main" }),
          "xd://other",
        ),
      ),
    ).toBeNull();
  });

  it("requires both repo and branch", () => {
    expect(
      parseRunWatchToolCall(writeDetail(JSON.stringify({ op: "run_watch", repo: "Dvitash/paseo" }))),
    ).toBeNull();
  });
});
