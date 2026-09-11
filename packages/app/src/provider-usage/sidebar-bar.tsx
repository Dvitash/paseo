import { memo, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import {
  type LayoutChangeEvent,
  Pressable,
  type PressableStateCallbackType,
  Text,
  View,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { buildSettingsHostSectionRoute, buildSettingsRoute } from "@/utils/host-routes";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThemedProviderUsageIcon, providerUsageIconColorMapping } from "./provider-usage-icon";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useAppVisible } from "@/hooks/use-app-visible";
import { getHostRuntimeStore, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import {
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import {
  resolveProviderUsageSlot,
  resolveSidebarHostServerId,
  resolveSidebarUsageGeometry,
  type SidebarProviderUsageSlot,
  type SidebarUsageDensity,
} from "./sidebar-usage-model";
import { useProviderUsage } from "./use-provider-usage";

function useEarliestOnlineHostServerId(): string | null {
  const store = getHostRuntimeStore();
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const unsubscribeAll = store.subscribeAll(onStoreChange);
      const unsubscribeHostList = store.subscribeHostList(onStoreChange);
      return () => {
        unsubscribeAll();
        unsubscribeHostList();
      };
    },
    [store],
  );
  return useSyncExternalStore(
    subscribe,
    () => store.getEarliestOnlineHostServerId(),
    () => store.getEarliestOnlineHostServerId(),
  );
}

export function useSidebarHostServerId(): string | null {
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const activeWorkspace = useActiveWorkspaceSelection();
  const lastWorkspace = useLastWorkspaceSelection();
  const earliestOnlineServerId = useEarliestOnlineHostServerId();
  const localDaemonServerId = useLocalDaemonServerId();
  const hosts = useHosts();
  const availableHostServerIds = useMemo(() => hosts.map((h) => h.serverId), [hosts]);

  return useMemo(
    () =>
      resolveSidebarHostServerId({
        hostFilters,
        activeWorkspaceServerId: activeWorkspace?.serverId,
        lastWorkspaceServerId: lastWorkspace?.serverId,
        earliestOnlineHostServerId: earliestOnlineServerId,
        localDaemonServerId,
        availableHostServerIds,
      }),
    [
      hostFilters,
      activeWorkspace?.serverId,
      lastWorkspace?.serverId,
      earliestOnlineServerId,
      localDaemonServerId,
      availableHostServerIds,
    ],
  );
}

function resolveDensityStyles(density: SidebarUsageDensity) {
  if (density === "spacious") {
    return { gapStyle: styles.gapSpacious, fontStyle: styles.fontSpacious };
  }
  if (density === "compact") {
    return { gapStyle: styles.gapCompact, fontStyle: styles.fontCompact };
  }
  return { gapStyle: styles.gapTight, fontStyle: styles.fontCompact };
}

function SidebarUsageSlotItem({
  slot,
  serverId,
  iconSize,
  density,
  showsName,
  slotBasisPercent,
  onPress,
}: {
  slot: SidebarProviderUsageSlot;
  serverId: string | null;
  iconSize: number;
  density: SidebarUsageDensity;
  showsName: boolean;
  slotBasisPercent: number;
  onPress: () => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const { gapStyle, fontStyle } = resolveDensityStyles(density);

  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  const slotStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.slot,
      { flexBasis: `${slotBasisPercent}%` as `${number}%` },
      gapStyle,
      Boolean(hovered) && styles.slotHovered,
    ],
    [gapStyle, slotBasisPercent],
  );

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          style={slotStyle}
          testID={`sidebar-provider-usage-${slot.providerId}`}
          nativeID={`sidebar-provider-usage-${slot.providerId}`}
          collapsable={false}
          accessible
          accessibilityRole="button"
          accessibilityLabel={slot.accessibilityLabel}
          onPress={onPress}
          onHoverIn={handleHoverIn}
          onHoverOut={handleHoverOut}
        >
          <ThemedProviderUsageIcon
            iconKey={slot.providerId}
            serverId={serverId}
            size={iconSize}
            uniProps={providerUsageIconColorMapping}
          />
          {showsName ? (
            <Text
              style={[styles.slotName, fontStyle, isHovered && styles.slotTextHovered]}
              numberOfLines={1}
            >
              {slot.displayName}
            </Text>
          ) : null}
          <Text
            style={[styles.slotText, fontStyle, isHovered && styles.slotTextHovered]}
            numberOfLines={1}
          >
            {slot.percentageText}
          </Text>
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{slot.tooltipText}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

export const SidebarProviderUsageBar = memo(function SidebarProviderUsageBar() {
  const router = useRouter();
  const isRetainedPanelActive = useRetainedPanelActive();
  const isAppVisible = useAppVisible();
  const serverId = useSidebarHostServerId();
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const [rowWidth, setRowWidth] = useState<number | null>(null);

  const isLive = isRetainedPanelActive && isAppVisible && isConnected;
  const { view } = useProviderUsage(serverId, {
    enabled: isRetainedPanelActive && isConnected,
    refetchInterval: isLive ? 60_000 : false,
    staleTime: 60_000,
  });

  const slots = useMemo(() => {
    if (view.kind !== "ready") {
      return [];
    }
    return view.payload.providers.map(resolveProviderUsageSlot);
  }, [view]);

  const handleOpenUsageSettings = useCallback(() => {
    if (serverId) {
      router.push(buildSettingsHostSectionRoute(serverId, "usage"));
    } else {
      router.push(buildSettingsRoute());
    }
  }, [router, serverId]);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) {
      setRowWidth(w);
    }
  }, []);

  const hasNoProviders = view.kind === "ready" && slots.length === 0;
  if (!serverId || hasNoProviders) {
    return null;
  }

  const statusMessage = view.kind === "error" ? view.message : "Loading provider usage...";

  const geometry = resolveSidebarUsageGeometry({
    slotCount: slots.length,
    availableWidth: rowWidth,
  });

  return (
    <View
      style={styles.container}
      testID="sidebar-provider-usage"
      nativeID="sidebar-provider-usage"
    >
      {view.kind === "ready" ? (
        <View style={styles.slotsRow} onLayout={handleLayout}>
          {slots.map((slot) => (
            <SidebarUsageSlotItem
              key={slot.providerId}
              slot={slot}
              serverId={serverId}
              iconSize={geometry.iconSize}
              density={geometry.density}
              showsName={geometry.showsName}
              slotBasisPercent={100 / geometry.slotsPerRow}
              onPress={handleOpenUsageSettings}
            />
          ))}
        </View>
      ) : (
        <Text style={styles.statusText} testID="sidebar-provider-usage-status" numberOfLines={2}>
          {statusMessage}
        </Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  statusText: {
    flex: 1,
    minHeight: 32,
    textAlign: "center",
    verticalAlign: "middle",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  slotsRow: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    minHeight: 32,
  },
  slot: {
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 0,
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
  },
  slotHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  slotText: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    minWidth: 0,
    flexShrink: 0,
  },
  slotName: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
    minWidth: 0,
    flexShrink: 1,
  },
  slotTextHovered: {
    color: theme.colors.foreground,
  },
  gapSpacious: {
    gap: theme.spacing[1.5],
  },
  gapCompact: {
    gap: theme.spacing[1],
  },
  gapTight: {
    gap: theme.spacing[0.5],
  },
  fontSpacious: {
    fontSize: theme.fontSize.base,
  },
  fontCompact: {
    fontSize: theme.fontSize.sm,
  },
  tooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
}));
