import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { ChevronDown } from "lucide-react-native";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import type { Theme } from "@/styles/theme";
import { useSidebarHostServerId } from "@/provider-usage/sidebar-bar";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { formatTokenStat } from "./format";
import { useTokenUsage } from "./use-token-usage";
import type { TimeRangeKey } from "./types";

const ThemedChevronDown = withUnistyles(ChevronDown);
const rangeIconColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const RANGE_OPTIONS: { value: TimeRangeKey; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

// Sidebar glance row for host token usage. Mirrors the host performance bar's
// label/value slots and stays silent unless the host reports a ready snapshot,
// so unsupported or offline hosts never nag from the sidebar. The range picker
// sits at the row's trailing edge and drives which window the slots summarize.
export const SidebarTokenUsageBar = memo(function SidebarTokenUsageBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const isRetainedPanelActive = useRetainedPanelActive();
  const isAppVisible = useAppVisible();
  const serverId = useSidebarHostServerId();
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const [isHovered, setIsHovered] = useState(false);
  const [range, setRange] = useState<TimeRangeKey>("24h");

  const isLive = isRetainedPanelActive && isAppVisible && isConnected;
  const { view } = useTokenUsage(serverId, {
    enabled: isRetainedPanelActive && isConnected,
    refetchInterval: isLive ? 60_000 : false,
  });

  const rangeItem = RANGE_OPTIONS.find((option) => option.value === range) ?? RANGE_OPTIONS[1];
  const rangeData = view.kind === "ready" ? view.ranges[range] : null;

  const handleOpenUsageSettings = useCallback(() => {
    if (serverId) {
      router.push(buildSettingsHostSectionRoute(serverId, "usage"));
    }
  }, [router, serverId]);

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  const rangeMenuItems = useMemo(
    () =>
      RANGE_OPTIONS.map((option) => (
        <RangeMenuItem
          key={option.value}
          option={option}
          selected={option.value === range}
          onSelect={setRange}
        />
      )),
    [range],
  );

  if (!serverId || view.kind !== "ready" || !rangeData) {
    return null;
  }

  const slots = [
    { key: "input", label: t("tokenUsage.sidebarInput"), value: rangeData.inputTokens },
    {
      key: "cache-read",
      label: t("tokenUsage.sidebarCacheRead"),
      value: rangeData.cacheReadTokens,
    },
    { key: "output", label: t("tokenUsage.sidebarOutput"), value: rangeData.outputTokens },
  ] as const;

  return (
    <View style={styles.container} testID="sidebar-token-usage" nativeID="sidebar-token-usage">
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <Pressable
            style={[styles.metricsRow, isHovered ? styles.metricsRowHovered : null]}
            onPress={handleOpenUsageSettings}
            onHoverIn={handleHoverIn}
            onHoverOut={handleHoverOut}
            accessibilityRole="button"
            accessibilityLabel={t("tokenUsage.title")}
            testID="sidebar-token-usage-button"
          >
            {slots.map((slot) => (
              <View key={slot.key} style={styles.slot} testID={`sidebar-token-usage-${slot.key}`}>
                <Text style={styles.slotLabel} numberOfLines={1}>
                  {slot.label}
                </Text>
                <Text style={styles.slotValue} numberOfLines={1}>
                  {formatTokenStat(slot.value)}
                </Text>
              </View>
            ))}
          </Pressable>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>
            {t("tokenUsage.sidebarTooltip", { range: rangeItem.label })}
          </Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={styles.rangeTrigger}
          testID="sidebar-token-usage-range"
          accessibilityRole="button"
          accessibilityLabel={t("tokenUsage.title")}
        >
          <Text style={styles.rangeText}>{rangeItem.label}</Text>
          <ThemedChevronDown size={12} uniProps={rangeIconColorMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="end"
          offset={8}
          testID="sidebar-token-usage-range-menu"
        >
          {rangeMenuItems}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
});

function RangeMenuItem({
  option,
  selected,
  onSelect,
}: {
  option: { value: TimeRangeKey; label: string };
  selected: boolean;
  onSelect: (value: TimeRangeKey) => void;
}) {
  const select = useCallback(() => onSelect(option.value), [onSelect, option.value]);
  return (
    <DropdownMenuItem
      selected={selected}
      onSelect={select}
      testID={`sidebar-token-usage-range-${option.value}`}
    >
      {option.label}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    gap: theme.spacing[1],
  },
  metricsRow: {
    flex: 1,
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  metricsRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  slot: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[1],
  },
  slotLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  slotValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    fontVariant: ["tabular-nums"],
    minWidth: 24,
    textAlign: "right",
  },
  rangeTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  rangeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
