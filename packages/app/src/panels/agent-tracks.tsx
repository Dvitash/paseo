import { memo, useCallback, useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { useShallow } from "zustand/shallow";
import { StyleSheet } from "react-native-unistyles";
import { collectRunningBackgroundJobs } from "@/composer/background-jobs";
import { BackgroundJobsPill } from "@/composer/background-jobs-pill";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { useWorkspaceHasDiffStat } from "@/composer/workspace-diff-stat";
import { AgentModelTurnMetricsPill, useHasModelTurnMetrics } from "@/composer/model-turn-metrics";
import { SubagentsPill } from "@/composer/subagents-pill";
import { AgentTaskList } from "@/composer/task-list";
import {
  MAX_CONTENT_WIDTH,
  supportsDesktopPaneSplits,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { usePaneContext } from "@/panels/pane-context";
import { useSettings } from "@/hooks/use-settings";
import { PluginComposerPills } from "@/plugins";
import { useSessionStore } from "@/stores/session-store";
import type { SubagentRow } from "@/subagents";
import { isSubagentActiveOrAttention } from "@/subagents/track-presentation";
import type { StreamItem, TodoEntry } from "@/types/stream";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { openComposerChanges } from "@/workspace-tabs/open-supporting-view";

const EMPTY_STREAM_ITEMS: StreamItem[] = [];

function isRunningSubagent(row: SubagentRow): boolean {
  return row.kind === "paseo"
    ? row.turn.phase === "open" || row.status === "running"
    : row.status === "running";
}

/** The pane's ambient context as compact tracks immediately above the composer. */
export const AgentTracks = memo(function AgentTracks({
  serverId,
  workspaceId,
  agentId,
  cwd,
  subagentRows,
  tasks,
  hasPluginComposerPills,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  cwd: string;
  subagentRows: SubagentRow[];
  tasks: TodoEntry[] | undefined;
  hasPluginComposerPills: boolean;
}): ReactElement | null {
  const { tabId, openTab } = usePaneContext();
  const hasWorkspaceDiffStat = useWorkspaceHasDiffStat(serverId, workspaceId);
  const hasModelTurnMetrics = useHasModelTurnMetrics(serverId, agentId);
  const isCompact = useIsCompactFormFactor();
  const canSplit = supportsDesktopPaneSplits() && !isCompact;
  const openInSidePane = useSettings((settings) => settings.openInSidePane);
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const streamState = useSessionStore(
    useShallow((state) => ({
      tail: state.sessions[serverId]?.agentStreamTail?.get(agentId) ?? EMPTY_STREAM_ITEMS,
      head: state.sessions[serverId]?.agentStreamHead?.get(agentId) ?? EMPTY_STREAM_ITEMS,
    })),
  );
  const streamItems = useMemo(
    () => [...streamState.tail, ...streamState.head],
    [streamState.head, streamState.tail],
  );
  const hasBackgroundJobs = collectRunningBackgroundJobs(streamItems).length > 0;
  const hasRunningSubagents = subagentRows.some(isRunningSubagent);

  const handleOpenSubagent = useCallback(
    (subagentId: string) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(subagentId) ?? session?.agentDetails.get(subagentId);
      if (agent?.workspaceId && agent.workspaceId !== workspaceId) {
        navigateToAgent({ serverId, agentId: subagentId });
        return;
      }
      if (canSplit && workspaceKey) {
        openPreferredWorkspaceTarget({
          isCompact,
          workspaceKey,
          target: { kind: "agent", agentId: subagentId },
          source: "subagents",
          preferences: openInSidePane,
          parentTabId: tabId,
        });
        return;
      }
      navigateToAgent({ serverId, agentId: subagentId });
    },
    [canSplit, isCompact, openInSidePane, serverId, tabId, workspaceId, workspaceKey],
  );
  const handleOpenProviderSubagent = useCallback(
    (parentAgentId: string, subagentId: string) => {
      if (canSplit && workspaceKey) {
        openPreferredWorkspaceTarget({
          isCompact,
          workspaceKey,
          target: { kind: "provider_subagent", parentAgentId, subagentId },
          source: "subagents",
          preferences: openInSidePane,
          parentTabId: tabId,
        });
        return;
      }
      openTab({ kind: "provider_subagent", parentAgentId, subagentId });
    },
    [canSplit, isCompact, openInSidePane, openTab, tabId, workspaceKey],
  );
  const handleOpenChanges = useCallback(() => {
    if (!workspaceKey) return;
    openComposerChanges({
      isCompact,
      workspaceKey,
      checkout: { serverId, cwd, isGit: true },
      preferences: openInSidePane,
    });
  }, [cwd, isCompact, openInSidePane, serverId, workspaceKey]);

  const hasPills =
    Boolean(tasks?.length) ||
    hasPluginComposerPills ||
    hasWorkspaceDiffStat ||
    hasModelTurnMetrics ||
    hasBackgroundJobs ||
    hasRunningSubagents;

  if (!hasPills) return null;

  return (
    <View style={styles.container} pointerEvents="box-none">
      <View style={styles.pillsRow} pointerEvents="box-none">
        <AgentTaskList tasks={tasks} />
        <PluginComposerPills
          serverId={serverId}
          workspaceId={workspaceId}
          agentId={agentId}
          compact={isCompact}
        />
        {hasRunningSubagents ? (
          <SubagentsPill
            rows={subagentRows}
            onOpenSubagent={handleOpenSubagent}
            onOpenProviderSubagent={handleOpenProviderSubagent}
          />
        ) : null}
        {hasBackgroundJobs ? <BackgroundJobsPill streamItems={streamItems} /> : null}
        <WorkspaceDiffStatPill
          serverId={serverId}
          workspaceId={workspaceId}
          onPress={handleOpenChanges}
        />
        {hasModelTurnMetrics ? (
          <AgentModelTurnMetricsPill serverId={serverId} agentId={agentId} />
        ) : null}
      </View>
    </View>
  );
});

export function hasAgentTracks({
  subagentRows,
  tasks,
  hasPluginComposerPills = false,
  hasModelTurnMetrics = false,
}: {
  subagentRows: readonly SubagentRow[];
  tasks: readonly TodoEntry[] | undefined;
  hasPluginComposerPills?: boolean;
  hasModelTurnMetrics?: boolean;
}): boolean {
  return (
    subagentRows.some(isSubagentActiveOrAttention) ||
    Boolean(tasks?.length) ||
    hasPluginComposerPills ||
    hasModelTurnMetrics
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[2],
  },
  pillsRow: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
