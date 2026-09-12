import { describe, expect, it } from "vitest";
import type { DaemonClient, FetchAgentsEntry } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import { createUserMessage, type TodoEntry } from "@/types/stream";
import type { DirectoryReplicaMutation } from "@/runtime/replica-cache";
import { AgentDirectoryReplica } from "./agent-replica";

function streamMessage(id: string) {
  return {
    kind: "user_message" as const,
    id,
    text: id,
    timestamp: new Date("2026-07-31T10:00:00.000Z"),
  };
}

function task(id: string): TodoEntry {
  return { id, text: id, status: "pending", completed: false };
}

function seedTransientState(serverId: string, agentId: string): void {
  const store = useSessionStore.getState();
  store.applyAgentTimelineResponseState(serverId, agentId, {
    items: [streamMessage(`${agentId}-tail`)],
    head: [],
    range: { epoch: "epoch", startSeq: 1, endSeq: 2 },
    older: "available",
    newer: true,
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
  store.setAgentStreamState(serverId, agentId, {
    head: [streamMessage(`${agentId}-head`)],
    taskSnapshot: [task(`${agentId}-task`)],
  });
  store.setAgentTimelineOlderFetchInFlight(serverId, (prev) => {
    const next = new Map(prev);
    next.set(agentId, true);
    return next;
  });
  store.beginAgentMessageSubmission(
    serverId,
    agentId,
    createUserMessage({
      clientMessageId: `${agentId}-submission`,
      text: "pending",
      timestamp: new Date("2026-07-31T10:00:00.000Z"),
    }),
  );
  store.setPendingPermissions(serverId, (prev) => {
    const next = new Map(prev);
    const key = `${agentId}-permission`;
    next.set(key, { key, agentId, request: null as never });
    return next;
  });
  store.setInitializingAgents(serverId, (prev) => {
    const next = new Map(prev);
    next.set(agentId, true);
    return next;
  });
  store.setQueuedMessages(serverId, (prev) => {
    const next = new Map(prev);
    next.set(agentId, [{ id: `${agentId}-queued`, text: "next", attachments: [] }]);
    return next;
  });
  store.setAgentLastActivityBatch((prev) => {
    const next = new Map(prev);
    next.set(agentId, new Date("2026-07-31T10:00:00.000Z"));
    return next;
  });
}

function transientPresence(serverId: string, agentId: string) {
  const state = useSessionStore.getState();
  const session = state.sessions[serverId];
  return {
    agent: session?.agents.has(agentId),
    streamHead: session?.agentStreamHead.has(agentId),
    streamTail: session?.agentStreamTail.has(agentId),
    tasks: session?.agentTasks.has(agentId),
    submissions: session?.messageSubmissions.has(agentId),
    cursor: session?.agentTimelineCursor.has(agentId),
    hasOlder: session?.agentTimelineHasOlder.has(agentId),
    hasNewer: session?.agentTimelineHasNewer.has(agentId),
    olderFetchInFlight: session?.agentTimelineOlderFetchInFlight.has(agentId),
    historySyncGeneration: session?.agentHistorySyncGeneration.has(agentId),
    authoritativeHistoryApplied: session?.agentAuthoritativeHistoryApplied.has(agentId),
    initializing: session?.initializingAgents.has(agentId),
    queued: session?.queuedMessages.has(agentId),
    permissions: Array.from(session?.pendingPermissions.values() ?? []).some(
      (pending) => pending.agentId === agentId,
    ),
    lastActivity: state.agentLastActivity.has(agentId),
  };
}

function payload(title: string, agentId = "agent"): AgentSnapshotPayload {
  return {
    id: agentId,
    provider: "codex",
    cwd: "/repo",
    model: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:01:00.000Z",
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title,
    labels: {},
  };
}

function entry(agent: AgentSnapshotPayload): FetchAgentsEntry {
  return {
    agent,
    project: {
      projectKey: "/repo",
      projectName: "repo",
      checkout: {
        cwd: "/repo",
        isGit: false,
        currentBranch: null,
        remoteUrl: null,
        worktreeRoot: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  };
}

describe("AgentDirectoryReplica", () => {
  it("does not let a late cache read replace newer live turn state", () => {
    const serverId = "agent-replica-late-cache";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );
    replica.commitSnapshot([entry(payload("live"))], []);
    replica.applyTurnLiveness("agent", {
      type: "stream_open",
      turn: { turnId: "turn-live", startedAt: null },
    });

    replica.commitCached(new Map([["agent", normalizeAgentSnapshot(payload("cached"), serverId)]]));

    expect(selectAgentTurnPresentation(store.getSession(serverId), "agent").turnId).toBe(
      "turn-live",
    );
    store.clearSession(serverId);
  });

  it("accepts the requested agent from the authoritative timeline after a cache miss", () => {
    const serverId = "agent-replica-cache-miss";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );

    expect(replica.submitTimelineAgent(replica.captureTimeline("agent"), payload("network"))).toBe(
      true,
    );
    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.title).toBe(
      "network",
    );
    store.clearSession(serverId);
  });

  it("persists stream-only turn transitions through the agent owner", () => {
    const serverId = "agent-replica-stream-turn";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const commits: DirectoryReplicaMutation[][] = [];
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      (mutations) => commits.push([...mutations]),
    );
    replica.commitSnapshot([entry(payload("agent"))], []);
    commits.length = 0;

    replica.applyTurnLiveness("agent", {
      type: "stream_open",
      turn: { turnId: "turn-1", startedAt: new Date("2026-08-31T12:00:00.000Z") },
    });

    expect(commits).toEqual([
      [
        expect.objectContaining({
          kind: "agent",
          type: "upsert",
          id: "agent",
          value: expect.objectContaining({
            status: "idle",
            turn: {
              phase: "open",
              cancellationRequestId: null,
              turnId: "turn-1",
              startedAt: new Date("2026-08-31T12:00:00.000Z"),
            },
          }),
        }),
      ],
    ]);
    expect(selectAgentTurnPresentation(store.getSession(serverId), "agent").isActive).toBe(true);
    store.clearSession(serverId);
  });

  it("notifies the queue owner exactly once when a stream turn closes", () => {
    const serverId = "agent-replica-stream-stop";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const stopped: string[] = [];
    const replica = new AgentDirectoryReplica(
      serverId,
      (agentId) => stopped.push(agentId),
      () => undefined,
    );
    replica.commitSnapshot([entry(payload("agent"))], []);
    replica.applyTurnLiveness("agent", {
      type: "stream_open",
      turn: { turnId: "turn-1", startedAt: null },
    });

    replica.applyTurnLiveness("agent", { type: "stream_close", turnId: "turn-1" });
    replica.applyTurnLiveness("agent", { type: "stream_close", turnId: "turn-1" });

    expect(stopped).toEqual(["agent"]);
    store.clearSession(serverId);
  });

  it("preserves cancellation state when the same active turn is snapshotted", () => {
    const serverId = "agent-replica-cancellation-snapshot";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );
    replica.commitSnapshot(
      [
        entry({
          ...payload("running"),
          activeTurn: { turnId: "turn-1", startedAt: null },
        }),
      ],
      [],
    );
    replica.applyTurnLiveness("agent", { type: "cancellation_started", requestId: 7 });

    replica.applyDelta({
      kind: "upsert",
      agent: {
        ...payload("same running turn"),
        activeTurn: { turnId: "turn-1", startedAt: null },
      },
      project: entry(payload("project")).project,
    });

    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.turn).toMatchObject({
      phase: "open",
      turnId: "turn-1",
      cancellationRequestId: 7,
    });

    replica.commitSnapshot(
      [
        entry({
          ...payload("same turn from refresh"),
          activeTurn: { turnId: "turn-1", startedAt: null },
        }),
      ],
      [],
    );
    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.turn).toMatchObject({
      phase: "open",
      turnId: "turn-1",
      cancellationRequestId: 7,
    });
    store.clearSession(serverId);
  });

  it("uses turn liveness for stopped transitions even when protocol status disagrees", () => {
    const serverId = "agent-replica-mismatched-status";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const stopped: string[] = [];
    const replica = new AgentDirectoryReplica(
      serverId,
      (agentId) => stopped.push(agentId),
      () => undefined,
    );
    replica.commitSnapshot(
      [
        entry({
          ...payload("open despite idle"),
          activeTurn: { turnId: "turn-1", startedAt: null },
        }),
      ],
      [],
    );

    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")).toMatchObject({
      status: "idle",
      turn: { phase: "open", turnId: "turn-1" },
    });

    replica.applyDelta({
      kind: "upsert",
      agent: { ...payload("idle turn despite running"), status: "running", activeTurn: null },
      project: entry(payload("project")).project,
    });
    replica.applyDelta({
      kind: "upsert",
      agent: { ...payload("status-only update"), status: "idle", activeTurn: null },
      project: entry(payload("project")).project,
    });

    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")).toMatchObject({
      status: "idle",
      turn: { phase: "idle" },
    });
    expect(stopped).toEqual(["agent"]);
    store.clearSession(serverId);
  });

  it("preserves an unchanged running agent's turn identity during catch-up", () => {
    const serverId = "agent-replica-catch-up";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );
    replica.commitSnapshot(
      [
        entry({
          ...payload("running"),
          status: "running",
          activeTurn: { turnId: "turn-1", startedAt: "2026-07-17T00:01:00.000Z" },
        }),
      ],
      [],
    );

    replica.commitChanges([], [], []);

    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.turn).toEqual({
      phase: "open",
      turnId: "turn-1",
      startedAt: new Date("2026-07-17T00:01:00.000Z"),
      cancellationRequestId: null,
    });
    store.clearSession(serverId);
  });

  it("drops every per-agent transient map for the removed agent only", () => {
    const serverId = "agent-replica-transient-removal";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );
    replica.commitSnapshot(
      [entry(payload("removed", "agent-removed")), entry(payload("kept", "agent-kept"))],
      [],
    );
    seedTransientState(serverId, "agent-removed");
    seedTransientState(serverId, "agent-kept");

    expect(transientPresence(serverId, "agent-removed")).toEqual({
      agent: true,
      streamHead: true,
      streamTail: true,
      tasks: true,
      submissions: true,
      cursor: true,
      hasOlder: true,
      hasNewer: true,
      olderFetchInFlight: true,
      historySyncGeneration: true,
      authoritativeHistoryApplied: true,
      initializing: true,
      queued: true,
      permissions: true,
      lastActivity: true,
    });

    replica.remove("agent-removed");

    expect(transientPresence(serverId, "agent-removed")).toEqual({
      agent: false,
      streamHead: false,
      streamTail: false,
      tasks: false,
      submissions: false,
      cursor: false,
      hasOlder: false,
      hasNewer: false,
      olderFetchInFlight: false,
      historySyncGeneration: false,
      authoritativeHistoryApplied: false,
      initializing: false,
      queued: false,
      permissions: false,
      lastActivity: false,
    });
    expect(transientPresence(serverId, "agent-kept")).toEqual({
      agent: true,
      streamHead: true,
      streamTail: true,
      tasks: true,
      submissions: true,
      cursor: true,
      hasOlder: true,
      hasNewer: true,
      olderFetchInFlight: true,
      historySyncGeneration: true,
      authoritativeHistoryApplied: true,
      initializing: true,
      queued: true,
      permissions: true,
      lastActivity: true,
    });
    store.clearSession(serverId);
  });

  it("keeps membership authoritative across remove, stale timeline, and re-add", () => {
    const serverId = "agent-replica";
    const store = useSessionStore.getState();
    store.initializeSession(serverId, null as unknown as DaemonClient);
    const replica = new AgentDirectoryReplica(
      serverId,
      () => undefined,
      () => undefined,
    );
    replica.commitSnapshot([entry(payload("directory"))], []);
    const directoryPlacement = useSessionStore
      .getState()
      .sessions[serverId]?.agents.get("agent")?.projectPlacement;
    expect(directoryPlacement).toBeDefined();
    const staleToken = replica.captureTimeline("agent");

    replica.remove("agent");
    expect(replica.submitTimelineAgent(staleToken, payload("stale"))).toBe(false);
    expect(useSessionStore.getState().sessions[serverId]?.agents.has("agent")).toBe(false);

    replica.applyDelta({
      kind: "upsert",
      agent: payload("re-added"),
      project: entry(payload("x")).project,
    });
    expect(replica.submitTimelineAgent(staleToken, payload("still stale"))).toBe(false);
    const currentToken = replica.captureTimeline("agent");
    expect(replica.submitTimelineAgent(currentToken, payload("current"))).toBe(true);
    expect(useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.title).toBe(
      "current",
    );
    expect(
      useSessionStore.getState().sessions[serverId]?.agents.get("agent")?.projectPlacement,
    ).toEqual(directoryPlacement);
    store.clearSession(serverId);
  });
});
