import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  buildChatHistoryAttachment,
  buildForkDraftSetup,
  type ForkAgentSource,
} from "@/hooks/use-fork-agent";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { generateDraftId } from "@/stores/draft-keys";

/** Prepares a new draft only. The caller chooses when to publish and navigate. */
export async function prepareSavedChatContinuation(input: {
  client: Pick<DaemonClient, "buildAgentForkContext">;
  serverId: string;
  agentId: string;
  sourceWorkspaceId: string;
  agent: ForkAgentSource;
  destination: Pick<WorkspaceDescriptor, "id" | "workspaceDirectory" | "archivingAt">;
  missingAttachmentMessage: string;
}) {
  if (input.destination.id === input.sourceWorkspaceId || input.destination.archivingAt) {
    throw new Error(
      "Choose an active destination workspace different from the archived workspace.",
    );
  }
  const payload = await input.client.buildAgentForkContext(input.agentId, { savedOnly: true });
  if (payload.error) throw new Error(payload.error);
  const draftId = generateDraftId();
  const setup = buildForkDraftSetup(input.agent);
  return {
    draftId,
    // Source cwd may have been deleted. New work belongs only to the chosen target.
    setup: setup ? { ...setup, cwd: input.destination.workspaceDirectory } : undefined,
    attachment: buildChatHistoryAttachment({
      draftId,
      serverId: input.serverId,
      agentId: input.agentId,
      payload,
      missingAttachmentMessage: input.missingAttachmentMessage,
    }),
  };
}
