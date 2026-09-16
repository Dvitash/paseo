import { expect, test, vi } from "vitest";
import { prepareSavedChatContinuation } from "./continue-saved-chat";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

function fixture() {
  const buildAgentForkContext = vi.fn<DaemonClient["buildAgentForkContext"]>().mockResolvedValue({
    requestId: "request",
    agentId: "source",
    attachment: { type: "text", mimeType: "text/plain", text: "saved context" },
    itemCount: 2,
    boundaryCursor: null,
    boundaryMessageId: null,
    error: null,
  });
  return {
    client: { buildAgentForkContext },
    serverId: "host",
    agentId: "source",
    sourceWorkspaceId: "archived",
    agent: { provider: "omp", cwd: "/removed", model: "model", currentModeId: "code" },
    destination: { id: "active", workspaceDirectory: "/chosen", archivingAt: null },
    missingAttachmentMessage: "History missing",
  };
}

test("creates a draft for the explicitly chosen cwd and preserves source metadata", async () => {
  const input = fixture();
  const result = await prepareSavedChatContinuation(input);
  expect(input.client.buildAgentForkContext).toHaveBeenCalledExactlyOnceWith("source", {
    savedOnly: true,
  });
  expect(result.setup).toMatchObject({ provider: "omp", model: "model", cwd: "/chosen" });
  expect(result.attachment).toMatchObject({
    kind: "chat_history",
    source: { serverId: "host", agentId: "source", itemCount: 2 },
  });
  expect(input.agent.cwd).toBe("/removed");
});

test("does not silently pick a target or swallow context failures", async () => {
  const input = fixture();
  await expect(
    prepareSavedChatContinuation({
      ...input,
      destination: { ...input.destination, id: "archived" },
    }),
  ).rejects.toThrow("Choose an active");
  expect(input.client.buildAgentForkContext).not.toHaveBeenCalled();
  input.client.buildAgentForkContext.mockRejectedValue(new Error("saved log unavailable"));
  await expect(prepareSavedChatContinuation(input)).rejects.toThrow("saved log unavailable");
});
