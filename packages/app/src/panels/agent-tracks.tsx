import { memo, useCallback, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { WorkspaceDiffStatPill } from "@/composer/diff-stat-pill";
import { useWorkspaceHasDiffStat } from "@/composer/workspace-diff-stat";
import { AgentModelTurnMetricsPill, useHasModelTurnMetrics } from "@/composer/model-turn-metrics";
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
import { useArchiveSubagent, useDetachSubagent, type SubagentRow } from "@/subagents";
import { SubagentsTrack } from "@/subagents/track";
import { isSubagentActiveOrAttention } from "@/subagents/track-presentation";
import type { TodoEntry } from "@/types/stream";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";
import { openComposerChanges } from "@/workspace-tabs/open-supporting-view";

/**
 * The pane's ambient context — workspace changes, subagents, and tasks — as a row of pills above
 * the composer.
 *
 * The row shares the composer's keyboard transform and owns the space between itself and the
 * transcript. Each pill owns its action while tab placement stays behind the workspace boundary.
 */
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
  const canDetachSubagents = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.agentDetach === true,
  );
  const archiveSubagent = useArchiveSubagent({ serverId });
  const detachSubagent = useDetachSubagent({ serverId });
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
    if (!workspaceKey) {
      return;
    }
    openComposerChanges({
      isCompact,
      workspaceKey,
      checkout: { serverId, cwd, isGit: true },
      preferences: openInSidePane,
    });
  }, [cwd, isCompact, openInSidePane, serverId, workspaceKey]);

  const hasPills =
    Boolean(tasks?.length) || hasPluginComposerPills || hasWorkspaceDiffStat || hasModelTurnMetrics;
  const hasSubagents = subagentRows.some(isSubagentActiveOrAttention);

  if (!hasPills && !hasSubagents) {
    return null;
  }

  return (
    <View style={styles.container} pointerEvents="box-none">
      {hasSubagents ? (
        <SubagentsTrack
          serverId={serverId}
          rows={subagentRows}
          onOpenSubagent={handleOpenSubagent}
          onOpenProviderSubagent={handleOpenProviderSubagent}
          onArchiveSubagent={archiveSubagent}
          onDetachSubagent={canDetachSubagents ? detachSubagent : undefined}
        />
      ) : null}
      {hasPills ? (
        <View style={styles.pillsRow} pointerEvents="box-none">
          <AgentTaskList tasks={tasks} />
          <PluginComposerPills
            serverId={serverId}
            workspaceId={workspaceId}
            agentId={agentId}
            compact={isCompact}
          />
          <WorkspaceDiffStatPill
            serverId={serverId}
            workspaceId={workspaceId}
            onPress={handleOpenChanges}
          />
          {hasModelTurnMetrics ? (
            <AgentModelTurnMetricsPill serverId={serverId} agentId={agentId} />
          ) : null}
        </View>
      ) : null}
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
    gap: theme.spacing[1.5],
  },
  pillsRow: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
