// @vitest-environment jsdom
/**
 * Regression: the stream slice used to be selected as a fresh object literal, so
 * every store notification produced a new snapshot. React then re-rendered in a
 * loop and the pane crashed with "Maximum update depth exceeded" (React #185) as
 * soon as a workspace pane mounted. The selector must stay shallow-stable.
 */
import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import React from "react";

vi.mock("expo-router", () => ({
  router: { dismissTo: vi.fn() },
  useLocalSearchParams: () => ({}),
  usePathname: () => "/",
}));

vi.mock("@/panels/pane-context", () => ({
  usePaneContext: () => ({ tabId: "tab-1", openTab: vi.fn() }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: (selector: (settings: { openInSidePane: boolean }) => unknown) =>
    selector({ openInSidePane: true }),
}));

vi.mock("@/plugins", () => ({
  PluginComposerPills: () => null,
}));

vi.mock("@/subagents", () => ({
  useArchiveSubagent: () => vi.fn(),
  useDetachSubagent: () => vi.fn(),
}));

vi.mock("@/subagents/track", () => ({
  SubagentsTrack: () => null,
}));

import { useSessionStore, type Agent } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { AgentTracks } from "./agent-tracks";

const SERVER_ID = "agent-tracks-server";
const WORKSPACE_ID = "agent-tracks-workspace";
const AGENT_ID = "agent-tracks-agent";
const TIMESTAMP = new Date("2026-09-16T00:00:00.000Z");

const AGENT: Agent = {
  id: AGENT_ID,
  provider: "codex",
  status: "running",
  turn: { phase: "open", turnId: "turn-1", startedAt: TIMESTAMP, cancellationRequestId: null },
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: TIMESTAMP,
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
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  serverId: SERVER_ID,
  cwd: "/repo",
  workspaceId: WORKSPACE_ID,
  model: null,
  features: undefined,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parentAgentId: null,
  labels: {},
  projectPlacement: null,
};

function buildStreamItems(count: number): StreamItem[] {
  return Array.from({ length: count }, (_, index) => ({
    kind: "assistant_message" as const,
    id: `message-${index}`,
    text: `chunk ${index}`,
    timestamp: new Date(1_700_000_000_000 + index),
  }));
}

function seedSession(): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as never);
  useSessionStore.getState().setAgents(SERVER_ID, new Map([[AGENT_ID, AGENT]]));
}

describe("AgentTracks", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    seedSession();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useSessionStore.getState().clearSession(SERVER_ID);
  });

  it("survives session updates without spinning the store subscription", () => {
    act(() => {
      root.render(
        <AgentTracks
          serverId={SERVER_ID}
          workspaceId={WORKSPACE_ID}
          agentId={AGENT_ID}
          cwd="/repo"
          subagentRows={[]}
          tasks={undefined}
          hasPluginComposerPills
        />,
      );
    });

    for (const count of [1, 2, 3]) {
      act(() => {
        useSessionStore
          .getState()
          .setAgentStreamState(SERVER_ID, AGENT_ID, { tail: buildStreamItems(count) });
      });
    }

    expect(container.childElementCount).toBeGreaterThan(0);
  });
});
