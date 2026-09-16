import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { Text, View, type LayoutChangeEvent } from "react-native";
import { Check, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useRetainedPanelActive } from "@/components/retained-panel";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useIsCompactFormFactor } from "@/constants/layout";
import { providerSubagentKey, useProviderSubagentStore } from "@/subagents/provider-store";
import type { ProviderSubagentRow } from "@/subagents/select";
import type { Theme } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import { formatDuration } from "@/utils/time";
import {
  collectBackgroundJobWaitCalls,
  shouldCollapseBackgroundJobs,
  type BackgroundJobWaitCall,
} from "./background-jobs";
import { composerPillStyles } from "./pill-styles";

const ThemedCheck = withUnistyles(Check);
const ThemedX = withUnistyles(X);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

interface BackgroundJobsPillsProps {
  serverId: string;
  rows: readonly ProviderSubagentRow[];
  parentStreamItems?: readonly StreamItem[];
  onOpenJob: (parentAgentId: string, subagentId: string) => void;
}

interface JobPresentation {
  row: ProviderSubagentRow;
  task: string;
  elapsedMs: number;
  waits: BackgroundJobWaitCall[];
}

function statusLabel(status: ProviderSubagentRow["status"]): string {
  if (status === "running") return "Running";
  if (status === "failed") return "Failed";
  if (status === "canceled") return "Canceled";
  return "Completed";
}

function resolveTask(row: ProviderSubagentRow): string {
  return row.description?.trim() || row.subtitle?.trim() || row.title?.trim() || row.id;
}

function JobStatusIcon({ status }: { status: ProviderSubagentRow["status"] }): ReactElement {
  if (status === "running") {
    return <ThemedLoadingSpinner size={14} uniProps={mutedMapping} />;
  }
  if (status === "failed" || status === "canceled") {
    return <ThemedX size={14} uniProps={dangerMapping} />;
  }
  return <ThemedCheck size={14} uniProps={successMapping} />;
}

function formatJobLabel(job: JobPresentation): string {
  const waitLabel = `${job.waits.length} ${job.waits.length === 1 ? "wait" : "waits"}`;
  return `${job.row.id} · ${waitLabel} · ${formatDuration(job.elapsedMs)}`;
}

function BackgroundJobMenu({
  job,
  onOpen,
}: {
  job: JobPresentation;
  onOpen: () => void;
}): ReactElement {
  const failed = job.row.status === "failed" || job.row.status === "canceled";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger accessibilityLabel={`Background job ${job.row.id}`}>
        {({ open, pressed, hovered }) => (
          <View
            style={[
              composerPillStyles.body,
              open || pressed || hovered ? composerPillStyles.bodyActive : null,
              failed ? styles.failedBody : null,
            ]}
          >
            <JobStatusIcon status={job.row.status} />
            <Text
              style={[
                composerPillStyles.label,
                job.row.status === "running" ? composerPillStyles.labelActive : null,
                failed ? styles.failedLabel : null,
              ]}
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
        minWidth={280}
        maxWidth={420}
        maxHeight={420}
        scrollable
        sheetTitle={job.row.id}
        testID={`background-job-menu-${job.row.id}`}
      >
        <DropdownMenuLabel>{job.task}</DropdownMenuLabel>
        <DropdownMenuItem disabled>
          {`${statusLabel(job.row.status)} · ${formatDuration(job.elapsedMs)} · ${job.waits.length} ${job.waits.length === 1 ? "wait" : "waits"}`}
        </DropdownMenuItem>
        {job.waits.length > 0 ? <DropdownMenuSeparator /> : null}
        {job.waits.map((wait, index) => (
          <DropdownMenuItem key={`${wait.id}:${index}`} disabled description={wait.status}>
            {wait.label}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpen}>Open subagent</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SummaryStatusIcon({ rows }: { rows: readonly ProviderSubagentRow[] }): ReactElement {
  if (rows.some((row) => row.status === "running")) {
    return <ThemedLoadingSpinner size={14} uniProps={mutedMapping} />;
  }
  if (rows.some((row) => row.status === "failed" || row.status === "canceled")) {
    return <ThemedX size={14} uniProps={dangerMapping} />;
  }
  return <ThemedCheck size={14} uniProps={successMapping} />;
}

function BackgroundJobsSummary({
  jobs,
  onOpenJob,
}: {
  jobs: readonly JobPresentation[];
  onOpenJob: (parentAgentId: string, subagentId: string) => void;
}): ReactElement {
  const active = jobs.some((job) => job.row.status === "running");
  const failed = jobs.some((job) => job.row.status === "failed" || job.row.status === "canceled");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger accessibilityLabel={`${jobs.length} background jobs`}>
        {({ open, pressed, hovered }) => (
          <View
            style={[
              composerPillStyles.body,
              open || pressed || hovered ? composerPillStyles.bodyActive : null,
              failed && !active ? styles.failedBody : null,
            ]}
          >
            <SummaryStatusIcon rows={jobs.map((job) => job.row)} />
            <Text
              style={[
                composerPillStyles.label,
                active ? composerPillStyles.labelActive : null,
                failed && !active ? styles.failedLabel : null,
              ]}
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
        minWidth={300}
        maxWidth={460}
        maxHeight={460}
        scrollable
        sheetTitle="Background jobs"
        testID="background-jobs-summary-menu"
      >
        <DropdownMenuLabel>Background jobs</DropdownMenuLabel>
        {jobs.map((job) => (
          <DropdownMenuItem
            key={job.row.id}
            leading={<JobStatusIcon status={job.row.status} />}
            description={job.task}
            onSelect={() => onOpenJob(job.row.parentAgentId, job.row.id)}
          >
            {formatJobLabel(job)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export const BackgroundJobsPills = memo(function BackgroundJobsPills({
  serverId,
  rows,
  parentStreamItems,
  onOpenJob,
}: BackgroundJobsPillsProps): ReactElement | null {
  const isCompact = useIsCompactFormFactor();
  const isPanelActive = useRetainedPanelActive();
  const descriptors = useProviderSubagentStore((state) => state.descriptors);
  const hasRunning = rows.some((row) => row.status === "running");
  const [now, setNow] = useState(() => Date.now());
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);

  useEffect(() => {
    if (!hasRunning || !isPanelActive) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [hasRunning, isPanelActive]);

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailableWidth(event.nativeEvent.layout.width);
  }, []);

  const jobs = useMemo<JobPresentation[]>(() => {
    return [...rows]
      .sort((left, right) => {
        const leftRunning = left.status === "running" ? 1 : 0;
        const rightRunning = right.status === "running" ? 1 : 0;
        if (leftRunning !== rightRunning) return rightRunning - leftRunning;
        const leftFailed = left.status === "failed" ? 1 : 0;
        const rightFailed = right.status === "failed" ? 1 : 0;
        if (leftFailed !== rightFailed) return rightFailed - leftFailed;
        return right.createdAt.getTime() - left.createdAt.getTime();
      })
      .map((row) => {
        const descriptor = descriptors.get(providerSubagentKey(serverId, row.parentAgentId, row.id));
        const terminalTime = descriptor?.updatedAt ? new Date(descriptor.updatedAt).getTime() : now;
        const endTime = row.status === "running" ? now : terminalTime;
        return {
          row,
          task: resolveTask(row),
          elapsedMs: Math.max(0, endTime - row.createdAt.getTime()),
          waits: collectBackgroundJobWaitCalls(parentStreamItems, row.id),
        };
      });
  }, [descriptors, now, parentStreamItems, rows, serverId]);

  if (jobs.length === 0) return null;

  const collapsed = shouldCollapseBackgroundJobs({
    count: jobs.length,
    availableWidth,
    compact: isCompact,
  });

  return (
    <View style={styles.container} onLayout={handleLayout} pointerEvents="box-none">
      {collapsed ? (
        <BackgroundJobsSummary jobs={jobs} onOpenJob={onOpenJob} />
      ) : (
        jobs.map((job) => (
          <BackgroundJobMenu
            key={job.row.id}
            job={job}
            onOpen={() => onOpenJob(job.row.parentAgentId, job.row.id)}
          />
        ))
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  failedBody: {
    borderColor: theme.colors.statusDanger,
  },
  failedLabel: {
    color: theme.colors.statusDanger,
  },
}));
