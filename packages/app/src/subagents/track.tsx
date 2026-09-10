import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, ChevronDown, MessageSquare, Unlink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { getProviderIcon } from "@/components/provider-icons";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { StatusRing } from "@/components/status-ring";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MAX_CONTENT_WIDTH } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import { formatDuration } from "@/utils/time";
import { providerSubagentKey, useProviderSubagentStore } from "./provider-store";
import type { PaseoSubagentRow, SubagentRow } from "./select";
import {
  buildSubagentPillPresentation,
  buildSubagentRowPresentationData,
  countFinishedSubagents,
  findLatestAssistantMessageText,
  getLatestToolCallOrThought,
  getRecentActions,
  isSubagentActiveOrAttention,
  sortSubagentRows,
  type RecentSubagentAction,
} from "./track-presentation";
import type { ArchiveFinishedStatus } from "./use-archive-finished";

const ThemedArchive = withUnistyles(Archive);
const ThemedUnlink = withUnistyles(Unlink);
const ThemedChevronDown = withUnistyles(ChevronDown);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ACCESSIBILITY_EXPANDED = { expanded: true } as const;
const ACCESSIBILITY_COLLAPSED = { expanded: false } as const;
const EMPTY_STREAM_ITEMS: readonly StreamItem[] = [];

export interface SubagentsTrackProps {
  serverId: string;
  rows: SubagentRow[];
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (id: string) => void;
  onArchiveFinished?: () => void;
  archiveFinishedStatus?: ArchiveFinishedStatus;
  onDetachSubagent?: (id: string) => void;
}

const IDLE_ARCHIVE_FINISHED_STATUS: ArchiveFinishedStatus = { kind: "idle" };
const ROW_ICON_SIZE = 14;
const DEFAULT_VISIBLE_COUNT = 5;

interface SubagentStreamSummary {
  activity: string | null;
  recentActions: RecentSubagentAction[];
  latestMessage: string | null;
}

function resolveSubagentActivityText(
  summary: SubagentStreamSummary | undefined,
  subtitle: string | undefined,
  isRunning: boolean,
  t: (key: string) => string,
): string | null {
  if (summary?.activity) {
    return summary.activity === "thinking" ? t("subagents.activityThinking") : summary.activity;
  }
  if (subtitle) {
    return subtitle;
  }
  if (isRunning) {
    return t("subagents.activityWorking");
  }
  return null;
}

function resolveSubagentStartedAt(row: SubagentRow): Date {
  if (row.kind === "paseo" && row.turn.phase === "open" && row.turn.startedAt) {
    return row.turn.startedAt;
  }
  return row.createdAt;
}

export function SubagentsTrack({
  serverId,
  rows,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onArchiveFinished,
  archiveFinishedStatus = IDLE_ARCHIVE_FINISHED_STATUS,
  onDetachSubagent,
}: SubagentsTrackProps): ReactElement | null {
  const { t } = useTranslation();
  const sourceId = useId();
  const isPanelActive = useRetainedPanelActive();
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);
  const [isOverflowExpanded, setIsOverflowExpanded] = useState(false);
  const [hydrationErrors, setHydrationErrors] = useState<Record<string, string>>({});

  const isArchivingFinished = archiveFinishedStatus.kind === "archiving";
  const isArchiveFinishedFailed = archiveFinishedStatus.kind === "failed";
  const finishedCount = countFinishedSubagents(rows);
  const showArchiveFinished = finishedCount > 0 || isArchivingFinished || isArchiveFinishedFailed;

  const agentStreamTail = useSessionStore((state) => state.sessions[serverId]?.agentStreamTail);
  const agentStreamHead = useSessionStore((state) => state.sessions[serverId]?.agentStreamHead);
  const client = useSessionStore((state) => state.sessions[serverId]?.client);
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[serverId]?.viewedTimelineSync ?? null,
  );
  const providerTimelines = useProviderSubagentStore((state) => state.timelines);

  // Subscribe to bridge updates for aggregate timeline error detection
  const [, setBridgeRevision] = useState(0);
  useEffect(() => {
    if (!viewedTimelineSync) return;
    return viewedTimelineSync.subscribe(() => setBridgeRevision((v) => v + 1));
  }, [viewedTimelineSync]);

  const sortedRows = useMemo(() => sortSubagentRows(rows), [rows]);

  const visibleRows = useMemo(() => sortedRows.filter(isSubagentActiveOrAttention), [sortedRows]);

  const hasOverflow = visibleRows.length > DEFAULT_VISIBLE_COUNT;
  const displayedRows = useMemo(() => {
    return hasOverflow && !isOverflowExpanded
      ? visibleRows.slice(0, DEFAULT_VISIBLE_COUNT)
      : visibleRows;
  }, [hasOverflow, isOverflowExpanded, visibleRows]);

  const overflowCount = visibleRows.length - DEFAULT_VISIBLE_COUNT;

  // Register displayed managed child IDs with viewedTimelineSync bridge
  const displayedManagedIds = useMemo(() => {
    return displayedRows
      .filter((row): row is PaseoSubagentRow => row.kind === "paseo")
      .map((row) => row.id);
  }, [displayedRows]);

  useEffect(() => {
    if (!viewedTimelineSync) return;
    viewedTimelineSync.replaceVisibleAgentIds(sourceId, isPanelActive ? displayedManagedIds : []);
  }, [displayedManagedIds, isPanelActive, sourceId, viewedTimelineSync]);

  useEffect(() => {
    if (!viewedTimelineSync) {
      return;
    }
    return () => {
      viewedTimelineSync.replaceVisibleAgentIds(sourceId, []);
    };
  }, [sourceId, viewedTimelineSync]);

  // Hydrate provider subagents for displayed rows (retaining key on failure to avoid auto-retry loop)
  const fetchedProviderIdsRef = useRef<Set<string>>(new Set());
  const hydrateProviderRow = useCallback(
    (parentAgentId: string, subagentId: string) => {
      if (!client) return;
      client
        .fetchProviderSubagentTimeline(parentAgentId, subagentId, {
          direction: "tail",
          limit: TIMELINE_FETCH_PAGE_SIZE,
        })
        .then((payload) => {
          useProviderSubagentStore.getState().replaceTimeline(serverId, payload);
          setHydrationErrors((prev) => {
            if (!prev[subagentId]) return prev;
            const next = { ...prev };
            delete next[subagentId];
            return next;
          });
          return undefined;
        })
        .catch((error: unknown) => {
          setHydrationErrors((prev) => ({
            ...prev,
            [subagentId]: error instanceof Error ? error.message : "Failed to load details",
          }));
        });
    },
    [client, serverId],
  );

  useEffect(() => {
    if (!client || !isPanelActive) return;
    for (const row of displayedRows) {
      if (row.kind === "provider") {
        const key = providerSubagentKey(serverId, row.parentAgentId, row.id);
        if (!fetchedProviderIdsRef.current.has(key)) {
          fetchedProviderIdsRef.current.add(key);
          hydrateProviderRow(row.parentAgentId, row.id);
        }
      }
    }
  }, [client, displayedRows, hydrateProviderRow, isPanelActive, serverId]);

  // Single aggregated memoized summary Map at collection owner - uses both tail and head
  const streamSummaries = useMemo<Record<string, SubagentStreamSummary>>(() => {
    const map: Record<string, SubagentStreamSummary> = {};
    for (const row of rows) {
      let tail: readonly StreamItem[] = EMPTY_STREAM_ITEMS;
      let head: readonly StreamItem[] = EMPTY_STREAM_ITEMS;
      if (row.kind === "paseo") {
        tail = agentStreamTail?.get(row.id) ?? EMPTY_STREAM_ITEMS;
        head = agentStreamHead?.get(row.id) ?? EMPTY_STREAM_ITEMS;
      } else {
        const key = providerSubagentKey(serverId, row.parentAgentId, row.id);
        const timeline = providerTimelines.get(key);
        tail = timeline?.tail ?? EMPTY_STREAM_ITEMS;
        head = timeline?.head ?? EMPTY_STREAM_ITEMS;
      }

      const items = tail.length > 0 || head.length > 0 ? [...tail, ...head] : undefined;

      map[row.id] = {
        activity: getLatestToolCallOrThought(items),
        recentActions: getRecentActions(items, 3),
        latestMessage: findLatestAssistantMessageText(items),
      };
    }
    return map;
  }, [agentStreamHead, agentStreamTail, providerTimelines, rows, serverId]);

  const handleToggleExpand = useCallback(
    (id: string) => setExpandedRowId((prev) => (prev === id ? null : id)),
    [],
  );

  const handleToggleOverflow = useCallback(() => setIsOverflowExpanded((prev) => !prev), []);

  const handleRetryHydration = useCallback(
    (row: SubagentRow) => {
      if (row.kind === "provider") {
        hydrateProviderRow(row.parentAgentId, row.id);
      } else if (viewedTimelineSync) {
        viewedTimelineSync.retryVisibleAgentTimeline(row.id);
      }
    },
    [hydrateProviderRow, viewedTimelineSync],
  );

  if (visibleRows.length === 0 && !(showArchiveFinished && onArchiveFinished)) {
    return null;
  }

  const pill = buildSubagentPillPresentation(t, rows);

  return (
    <View style={styles.card} testID="subagents-track-header-panel">
      <View style={styles.header} testID="subagents-track-header">
        <View style={styles.headerLeft}>
          <Text style={styles.headerTitle}>{t("subagents.title")}</Text>
          <Text style={styles.headerMeta} numberOfLines={1}>
            {pill.accessibilityLabel}
          </Text>
        </View>
        {showArchiveFinished && onArchiveFinished ? (
          <ArchiveFinishedRow
            status={archiveFinishedStatus}
            disabled={isArchivingFinished}
            onPress={onArchiveFinished}
          />
        ) : null}
      </View>

      <ScrollView
        style={styles.rowsScroll}
        contentContainerStyle={styles.rowsContainer}
        showsVerticalScrollIndicator
        nestedScrollEnabled
      >
        {displayedRows.map((row) => (
          <SubagentsTrackRow
            key={row.id}
            row={row}
            serverId={serverId}
            summary={streamSummaries[row.id]}
            hydrationError={
              hydrationErrors[row.id] ??
              (row.kind === "paseo" && viewedTimelineSync
                ? (viewedTimelineSync.getAgentTimelineError(row.id) ?? undefined)
                : undefined)
            }
            onRetryHydration={handleRetryHydration}
            isExpanded={expandedRowId === row.id}
            onToggleExpand={handleToggleExpand}
            onOpenSubagent={onOpenSubagent}
            onOpenProviderSubagent={onOpenProviderSubagent}
            onArchiveSubagent={onArchiveSubagent}
            onDetachSubagent={onDetachSubagent}
          />
        ))}
      </ScrollView>

      {hasOverflow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            isOverflowExpanded
              ? t("subagents.showLess")
              : t("subagents.showMore", { count: overflowCount })
          }
          testID="subagents-track-overflow-toggle"
          onPress={handleToggleOverflow}
          style={styles.overflowToggleRow}
        >
          <Text style={styles.overflowToggleText}>
            {isOverflowExpanded
              ? t("subagents.showLess")
              : t("subagents.showMore", { count: overflowCount })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ArchiveFinishedRow({
  status,
  disabled,
  onPress,
}: {
  status: ArchiveFinishedStatus;
  disabled: boolean;
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();

  let label = t("subagents.archiveFinishedAction");
  if (status.kind === "archiving") {
    label = `${t("subagents.archiveFinishedAction")} (${status.completedCount}/${status.totalCount})`;
  } else if (status.kind === "failed") {
    label = t("subagents.archiveFinishedRetry", {
      failed: status.failedCount,
      total: status.totalCount,
    });
  }

  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={disabled}
      leftIcon={Archive}
      testID="subagents-track-archive-finished"
      onPress={onPress}
    >
      {label}
    </Button>
  );
}

function SubagentStatusIcon({
  row,
  serverId,
}: {
  row: SubagentRow;
  serverId: string;
}): ReactElement {
  const ProviderIcon = getProviderIcon(row.provider, serverId);
  const isRunning =
    row.kind === "paseo"
      ? row.turn.phase === "open" || row.status === "running"
      : row.status === "running";
  const isFailed = row.status === "error" || row.status === "failed";
  const isAttention = row.requiresAttention;

  return (
    <View style={styles.statusIconWrapper}>
      <ProviderIcon size={14} color={styles.iconMuted.color} />
      {isRunning ? (
        <View
          style={styles.statusRingOverlay}
          accessibilityRole="progressbar"
          accessibilityLabel="Agent running"
        >
          <StatusRing />
        </View>
      ) : null}
      {isFailed ? <View style={styles.dotFailed} /> : null}
      {!isFailed && isAttention ? <View style={styles.dotAttention} /> : null}
    </View>
  );
}

interface SubagentsTrackRowProps {
  serverId: string;
  row: SubagentRow;
  summary?: SubagentStreamSummary;
  hydrationError?: string;
  onRetryHydration: (row: SubagentRow) => void;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
  onArchiveSubagent: (id: string) => void;
  onDetachSubagent?: (id: string) => void;
}

const SubagentsTrackRow = memo(function SubagentsTrackRow({
  serverId,
  row,
  summary,
  hydrationError,
  onRetryHydration,
  isExpanded,
  onToggleExpand,
  onOpenSubagent,
  onOpenProviderSubagent,
  onArchiveSubagent,
  onDetachSubagent,
}: SubagentsTrackRowProps): ReactElement {
  const { t } = useTranslation();
  const presentation = useMemo(() => buildSubagentRowPresentationData(row), [row]);
  const displayLabel =
    presentation.titleState === "loading" ? t("common.states.loading") : presentation.label;

  const isRunning =
    row.kind === "paseo"
      ? row.turn.phase === "open" || row.status === "running"
      : row.status === "running";

  const startedAt = resolveSubagentStartedAt(row);
  const activityText = resolveSubagentActivityText(summary, presentation.subtitle, isRunning, t);

  const handlePressRow = useCallback(() => {
    onToggleExpand(row.id);
  }, [onToggleExpand, row.id]);

  const handleOpen = useCallback(() => {
    if (row.kind === "provider") {
      onOpenProviderSubagent(row.parentAgentId, row.id);
    } else {
      onOpenSubagent(row.id);
    }
  }, [onOpenProviderSubagent, onOpenSubagent, row]);

  const handleArchive = useCallback(() => {
    onArchiveSubagent(row.id);
  }, [onArchiveSubagent, row.id]);

  const handleDetach = useCallback(() => {
    onDetachSubagent?.(row.id);
  }, [onDetachSubagent, row.id]);

  return (
    <View style={styles.rowWrapper}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={displayLabel}
        accessibilityState={isExpanded ? ACCESSIBILITY_EXPANDED : ACCESSIBILITY_COLLAPSED}
        testID={`subagents-track-row-${row.id}`}
        onPress={handlePressRow}
        style={isExpanded ? styles.rowExpanded : styles.row}
      >
        <SubagentStatusIcon row={row} serverId={serverId} />
        <Text style={styles.rowLabel} numberOfLines={1}>
          {displayLabel}
        </Text>

        {activityText ? (
          <Text style={styles.rowActivity} numberOfLines={1}>
            {activityText}
          </Text>
        ) : null}

        {isRunning ? <SubagentElapsed startedAt={startedAt} rowId={row.id} /> : null}

        {row.kind === "paseo" ? (
          <SubagentRowActions
            rowId={row.id}
            displayLabel={displayLabel}
            visible={isExpanded}
            onDetachPress={onDetachSubagent ? handleDetach : undefined}
            onArchivePress={handleArchive}
          />
        ) : null}

        <ThemedChevronDown
          size={13}
          uniProps={foregroundMutedColorMapping}
          style={isExpanded ? styles.chevronOpen : styles.chevronClosed}
        />
      </Pressable>

      {isExpanded ? (
        <SubagentExpandedDetails
          row={row}
          summary={summary}
          hydrationError={hydrationError}
          onRetryHydration={onRetryHydration}
          onOpen={handleOpen}
          onArchive={handleArchive}
          onDetach={onDetachSubagent ? handleDetach : undefined}
        />
      ) : null}
    </View>
  );
});

function SubagentElapsed({ startedAt, rowId }: { startedAt: Date; rowId: string }): ReactElement {
  const isPanelActive = useRetainedPanelActive();
  const startedAtMs = startedAt.getTime();
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - startedAtMs));

  useEffect(() => {
    if (!isPanelActive) return;
    setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    const handle = setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - startedAtMs));
    }, 1000);
    return () => clearInterval(handle);
  }, [isPanelActive, startedAtMs]);

  return (
    <Text style={styles.rowElapsed} testID={`subagents-track-elapsed-${rowId}`}>
      {formatDuration(elapsedMs)}
    </Text>
  );
}

function SubagentExpandedDetails({
  row,
  summary,
  hydrationError,
  onRetryHydration,
  onOpen,
  onArchive,
  onDetach,
}: {
  row: SubagentRow;
  summary?: SubagentStreamSummary;
  hydrationError?: string;
  onRetryHydration: (row: SubagentRow) => void;
  onOpen: () => void;
  onArchive: () => void;
  onDetach?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const recentActions = summary?.recentActions ?? [];
  const latestMessage = summary?.latestMessage ?? null;

  const handleRetry = useCallback(() => {
    onRetryHydration(row);
  }, [onRetryHydration, row]);

  return (
    <View style={styles.detailsContainer} testID={`subagents-track-details-${row.id}`}>
      {hydrationError ? (
        <View style={styles.errorSection}>
          <Text style={styles.errorText}>{hydrationError}</Text>
          <Button size="xs" variant="outline" onPress={handleRetry}>
            {t("common.actions.retry")}
          </Button>
        </View>
      ) : null}

      {recentActions.length > 0 ? (
        <View style={styles.detailsSection}>
          <Text style={styles.detailsSectionTitle}>{t("subagents.recentActions")}</Text>
          <View style={styles.detailsActionsList}>
            {recentActions.map((action) => {
              const isRunning = action.status === "running" || action.status === "executing";
              const isFailed = action.status === "failed";
              let dotStyle = styles.actionDotCompleted;
              if (isRunning) {
                dotStyle = styles.actionDotWorking;
              } else if (isFailed) {
                dotStyle = styles.actionDotFailed;
              }
              return (
                <View key={action.id} style={styles.actionItemRow}>
                  <View style={[styles.actionDot, dotStyle]} />
                  <Text style={styles.actionItemTitle} numberOfLines={1}>
                    {action.name}
                  </Text>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}

      {latestMessage ? (
        <View style={styles.detailsSection}>
          <Text style={styles.detailsSectionTitle}>{t("subagents.latestMessage")}</Text>
          <View style={styles.latestMessageBox}>
            <Text style={styles.latestMessageText} numberOfLines={3}>
              {latestMessage}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={styles.actionBar}>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={MessageSquare}
          testID={`subagents-track-open-${row.id}`}
          onPress={onOpen}
        >
          {t("subagents.openConversation")}
        </Button>

        {row.kind === "paseo" ? (
          <SubagentRowActions
            rowId={row.id}
            displayLabel={row.title ?? ""}
            visible
            onDetachPress={onDetach}
            onArchivePress={onArchive}
          />
        ) : null}
      </View>
    </View>
  );
}

function SubagentRowActions({
  rowId,
  displayLabel,
  visible,
  onDetachPress,
  onArchivePress,
}: {
  rowId: string;
  displayLabel: string;
  visible: boolean;
  onDetachPress?: () => void;
  onArchivePress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={visible ? styles.actionClusterVisible : styles.actionClusterHidden}
      pointerEvents={visible ? "auto" : "none"}
    >
      {onDetachPress ? (
        <SubagentActionButton
          accessibilityLabel={t("subagents.detachAction", { label: displayLabel })}
          testID={`subagents-track-detach-${rowId}`}
          tooltipLabel={t("subagents.detachTooltip")}
          icon="detach"
          visible={visible}
          onPress={onDetachPress}
        />
      ) : null}
      <SubagentActionButton
        accessibilityLabel={t("subagents.archiveAction", { label: displayLabel })}
        testID={`subagents-track-archive-${rowId}`}
        tooltipLabel={t("subagents.archiveTooltip")}
        icon="archive"
        visible={visible}
        onPress={onArchivePress}
      />
    </View>
  );
}

type SubagentActionIcon = "archive" | "detach";

function renderSubagentActionIcon(icon: SubagentActionIcon, isActive: boolean): ReactElement {
  const uniProps = isActive ? foregroundColorMapping : foregroundMutedColorMapping;
  if (icon === "detach") {
    return <ThemedUnlink size={ROW_ICON_SIZE} uniProps={uniProps} />;
  }
  return <ThemedArchive size={ROW_ICON_SIZE} uniProps={uniProps} />;
}

function SubagentActionButton({
  accessibilityLabel,
  testID,
  tooltipLabel,
  icon,
  visible,
  onPress,
}: {
  accessibilityLabel: string;
  testID: string;
  tooltipLabel: string;
  icon: SubagentActionIcon;
  visible: boolean;
  onPress: () => void;
}): ReactElement {
  return (
    <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild disabled={!visible}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          testID={testID}
          onPress={onPress}
          style={styles.actionButton}
          hitSlop={8}
        >
          {({ hovered, pressed }) => renderSubagentActionIcon(icon, hovered || pressed)}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{tooltipLabel}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    width: "100%",
    maxWidth: MAX_CONTENT_WIDTH,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  headerTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  headerMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    minWidth: 0,
  },
  rowsScroll: {
    maxHeight: 240,
  },
  rowsContainer: {
    width: "100%",
  },
  rowWrapper: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 34,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  rowExpanded: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 34,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    backgroundColor: theme.colors.surface2,
  },
  statusIconWrapper: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  statusRingOverlay: {
    position: "absolute",
  },
  dotFailed: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.colors.statusDanger,
  },
  dotAttention: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.colors.statusWarning,
  },
  iconMuted: {
    color: theme.colors.foregroundMuted,
  },
  rowLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  rowActivity: {
    flexGrow: 1,
    flexShrink: 2,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowElapsed: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  chevronClosed: {
    transform: [{ rotate: "0deg" }],
  },
  chevronOpen: {
    transform: [{ rotate: "180deg" }],
  },
  actionClusterVisible: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 1,
  },
  actionClusterHidden: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    opacity: 0,
  },
  actionButton: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  detailsContainer: {
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  errorSection: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[1.5],
    borderRadius: theme.borderRadius.sm,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
    flexShrink: 1,
  },
  detailsSection: {
    gap: theme.spacing[1],
  },
  detailsSectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
  },
  detailsActionsList: {
    gap: theme.spacing[1],
  },
  actionItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  actionDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  actionDotWorking: {
    backgroundColor: theme.colors.statusWarning,
  },
  actionDotFailed: {
    backgroundColor: theme.colors.statusDanger,
  },
  actionDotCompleted: {
    backgroundColor: theme.colors.statusSuccess,
  },
  actionItemTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  latestMessageBox: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.sm,
    padding: theme.spacing[2],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  latestMessageText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: theme.spacing[1],
  },
  overflowToggleRow: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1.5],
    backgroundColor: theme.colors.surface0,
  },
  overflowToggleText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
  },
}));
