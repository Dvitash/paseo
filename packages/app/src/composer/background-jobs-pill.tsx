import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import { formatDuration } from "@/utils/time";
import { collectBackgroundJobs, shouldCollapseBackgroundJobs, type BackgroundJobSnapshot } from "./background-jobs";
import { composerPillStyles } from "./pill-styles";

const ThemedCheck = withUnistyles(Check);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

interface BackgroundJobsPillsProps {
  streamItems?: readonly StreamItem[];
  active: boolean;
}

interface JobPresentation extends BackgroundJobSnapshot {
  elapsedMs: number;
}

function JobStatusIcon({ active }: { active: boolean }): ReactElement {
  if (active) return <ThemedLoadingSpinner size={14} uniProps={mutedMapping} />;
  return <ThemedCheck size={14} uniProps={successMapping} />;
}

function formatJobLabel(job: JobPresentation): string {
  return `${job.id} · ${formatDuration(job.elapsedMs)}`;
}

function BackgroundJobMenu({ job, active }: { job: JobPresentation; active: boolean }): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger accessibilityLabel={`Background job ${job.id}`}>
        {({ open, pressed, hovered }) => (
          <View
            style={[
              composerPillStyles.body,
              open || pressed || hovered ? composerPillStyles.bodyActive : null,
            ]}
          >
            <JobStatusIcon active={active} />
            <Text
              style={[composerPillStyles.label, active ? composerPillStyles.labelActive : null]}
              numberOfLines={1}
            >
              {formatJobLabel(job)}
            </Text>
          </View>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        minWidth={240}
        maxWidth={380}
        sheetTitle={job.id}
        testID={`background-job-menu-${job.id}`}
      >
        <DropdownMenuLabel>{job.id}</DropdownMenuLabel>
        <DropdownMenuItem disabled>
          {`${active ? "Running" : "Finished"} · ${formatDuration(job.elapsedMs)}`}
        </DropdownMenuItem>
        {job.label ? <DropdownMenuItem disabled>{job.label}</DropdownMenuItem> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BackgroundJobsSummary({ jobs, active }: { jobs: readonly JobPresentation[]; active: boolean }): ReactElement {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger accessibilityLabel={`${jobs.length} background jobs`}>
        {({ open, pressed, hovered }) => (
          <View
            style={[
              composerPillStyles.body,
              open || pressed || hovered ? composerPillStyles.bodyActive : null,
            ]}
          >
            <JobStatusIcon active={active} />
            <Text
              style={[composerPillStyles.label, active ? composerPillStyles.labelActive : null]}
              numberOfLines={1}
            >
              {`${jobs.length} background jobs`}
            </Text>
          </View>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        minWidth={280}
        maxWidth={420}
        maxHeight={420}
        scrollable
        sheetTitle="Background jobs"
        testID="background-jobs-summary-menu"
      >
        <DropdownMenuLabel>Background jobs</DropdownMenuLabel>
        {jobs.map((job) => (
          <DropdownMenuItem key={job.id} disabled leading={<JobStatusIcon active={active} />} description={job.label ?? undefined}>
            {formatJobLabel(job)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const BackgroundJobsPills = memo(function BackgroundJobsPills({
  streamItems,
  active,
}: BackgroundJobsPillsProps): ReactElement | null {
  const isCompact = useIsCompactFormFactor();
  const isPanelActive = useRetainedPanelActive();
  const [now, setNow] = useState(() => Date.now());
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!active || !isPanelActive) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [active, isPanelActive]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailableWidth(event.nativeEvent.layout.width);
  }, []);

  const jobs = useMemo<JobPresentation[]>(() => {
    return collectBackgroundJobs(streamItems).map((job) => ({
      ...job,
      elapsedMs: Math.max(0, (active ? now : job.lastSeenAt.getTime()) - job.startedAt.getTime()),
    }));
  }, [active, now, streamItems]);

  if (jobs.length === 0) return null;

  const collapsed = shouldCollapseBackgroundJobs({
    count: jobs.length,
    availableWidth,
    compact: isCompact,
  });

  return (
    <View style={styles.container} onLayout={handleLayout} pointerEvents="box-none">
      {collapsed ? (
        <BackgroundJobsSummary jobs={jobs} active={active} />
      ) : (
        jobs.map((job) => <BackgroundJobMenu key={job.id} job={job} active={active} />)
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    minWidth: 0,
  },
}));
