import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useSidebarHostServerId } from "@/provider-usage/sidebar-bar";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { formatTokenStat } from "./format";
import { useTokenUsage } from "./use-token-usage";

// Sidebar glance row for host token usage. Mirrors the host performance bar's
// label/value slots and stays silent unless the host reports a ready snapshot,
// so unsupported or offline hosts never nag from the sidebar.
export const SidebarTokenUsageBar = memo(function SidebarTokenUsageBar() {
  const { t } = useTranslation();
  const router = useRouter();
  const isRetainedPanelActive = useRetainedPanelActive();
  const isAppVisible = useAppVisible();
  const serverId = useSidebarHostServerId();
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const [isHovered, setIsHovered] = useState(false);

  const isLive = isRetainedPanelActive && isAppVisible && isConnected;
  const { view } = useTokenUsage(serverId, {
    enabled: isRetainedPanelActive && isConnected,
    refetchInterval: isLive ? 60_000 : false,
  });

  const range = view.kind === "ready" ? view.ranges["24h"] : null;

  const handleOpenUsageSettings = useCallback(() => {
    if (serverId) {
      router.push(buildSettingsHostSectionRoute(serverId, "usage"));
    }
  }, [router, serverId]);

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  if (!serverId || view.kind !== "ready" || !range) {
    return null;
  }

  const slots = [
    { key: "input", label: t("tokenUsage.sidebarInput"), value: range.inputTokens },
    { key: "cache-read", label: t("tokenUsage.sidebarCacheRead"), value: range.cacheReadTokens },
    { key: "output", label: t("tokenUsage.sidebarOutput"), value: range.outputTokens },
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
          <Text style={styles.tooltipText}>{t("tokenUsage.sidebarTooltip")}</Text>
        </TooltipContent>
      </Tooltip>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
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
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
