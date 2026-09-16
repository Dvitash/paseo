import { memo, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { ProviderSubagentRow } from "@/subagents/select";
import type { Theme } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import { formatDuration } from "@/utils/time";
import { collectRunningBackgroundJobs, type BackgroundJobSnapshot } from "./background-jobs";
import { composerPillStyles } from "./pill-styles";
import { SubagentsPill } from "./subagents-pill";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface BackgroundJobsPillProps {
  streamItems?: readonly StreamItem[];
}

interface JobPresentation extends BackgroundJobSnapshot {
  elapsedMs: number;
}

export const BackgroundJobsPill = memo(function BackgroundJobsPill({
  streamItems,
}: BackgroundJobsPillProps): ReactElement | null {
  const isPanelActive = useRetainedPanelActive();
  const [now, setNow] = useState(() => Date.now());
  const runningJobs = useMemo(() => collectRunningBackgroundJobs(streamItems), [streamItems]);

  useEffect(() => {
    if (!isPanelActive || runningJobs.length === 0) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [isPanelActive, runningJobs.length]);

  const jobs = useMemo<JobPresentation[]>(
    () =>
      runningJobs.map((job) => ({
        ...job,
        elapsedMs: Math.max(0, now - job.startedAt.getTime()),
      })),
    [now, runningJobs],
  );

  if (jobs.length === 0) return null;

  const label = `${jobs.length} background ${jobs.length === 1 ? "job" : "jobs"}`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger accessibilityLabel={`${label} running`}>
        {({ open, pressed, hovered }) => (
          <View
            style={[
              composerPillStyles.body,
              open || pressed || hovered ? composerPillStyles.bodyActive : null,
            ]}
          >
            <ThemedLoadingSpinner size={14} uniProps={mutedMapping} />
            <Text style={composerPillStyles.labelActive} numberOfLines={1}>
              {label}
            </Text>
          </View>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        minWidth={260}
        maxWidth={380}
        maxHeight={360}
        scrollable
        sheetTitle="Background jobs"
        testID="background-jobs-menu"
      >
        <DropdownMenuLabel>Running background jobs</DropdownMenuLabel>
        {jobs.map((job) => (
          <DropdownMenuItem key={job.id} disabled>
            {`${job.id} · ${formatDuration(job.elapsedMs)}`}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

/** Nested provider panes still pass their child rows here; render the same two independent pills. */
export const BackgroundJobsPills = memo(function BackgroundJobsPills({
  rows,
  parentStreamItems,
  onOpenJob,
}: {
  serverId: string;
  rows: readonly ProviderSubagentRow[];
  parentStreamItems?: readonly StreamItem[];
  onOpenJob: (parentAgentId: string, subagentId: string) => void;
}): ReactElement | null {
  const hasSubagents = rows.some((row) => row.status === "running");
  const hasJobs = collectRunningBackgroundJobs(parentStreamItems).length > 0;
  if (!hasSubagents && !hasJobs) return null;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {hasSubagents ? (
        <SubagentsPill
          rows={rows}
          onOpenSubagent={() => undefined}
          onOpenProviderSubagent={onOpenJob}
        />
      ) : null}
      {hasJobs ? <BackgroundJobsPill streamItems={parentStreamItems} /> : null}
    </View>
  );
});
