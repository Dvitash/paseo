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
import type { SubagentRow } from "@/subagents";
import type { Theme } from "@/styles/theme";
import { formatDuration } from "@/utils/time";
import { composerPillStyles } from "./pill-styles";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function isRunning(row: SubagentRow): boolean {
  return row.kind === "paseo"
    ? row.turn.phase === "open" || row.status === "running"
    : row.status === "running";
}

function startedAt(row: SubagentRow): Date {
  if (row.kind === "paseo" && row.turn.phase === "open" && row.turn.startedAt) {
    return row.turn.startedAt;
  }
  return row.createdAt;
}

function labelFor(row: SubagentRow): string {
  return row.description?.trim() || row.title?.trim() || row.id;
}

export const SubagentsPill = memo(function SubagentsPill({
  rows,
  onOpenSubagent,
  onOpenProviderSubagent,
}: {
  rows: readonly SubagentRow[];
  onOpenSubagent: (id: string) => void;
  onOpenProviderSubagent: (parentAgentId: string, subagentId: string) => void;
}): ReactElement | null {
  const isPanelActive = useRetainedPanelActive();
  const runningRows = useMemo(() => rows.filter(isRunning), [rows]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isPanelActive || runningRows.length === 0) return;
    setNow(Date.now());
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [isPanelActive, runningRows.length]);

  if (runningRows.length === 0) return null;

  const label = `${runningRows.length} ${runningRows.length === 1 ? "subagent" : "subagents"}`;
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
        minWidth={300}
        maxWidth={440}
        maxHeight={360}
        scrollable
        sheetTitle="Subagents"
        testID="running-subagents-menu"
      >
        <DropdownMenuLabel>Running subagents</DropdownMenuLabel>
        {runningRows.map((row) => (
          <DropdownMenuItem
            key={`${row.kind}:${row.id}`}
            description={`${formatDuration(Math.max(0, now - startedAt(row).getTime()))} running`}
            onSelect={() => {
              if (row.kind === "provider") {
                onOpenProviderSubagent(row.parentAgentId, row.id);
              } else {
                onOpenSubagent(row.id);
              }
            }}
          >
            {labelFor(row)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
