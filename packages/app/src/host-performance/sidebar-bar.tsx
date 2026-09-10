import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Server } from "lucide-react-native";
import { HostPicker } from "@/components/hosts/host-picker";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Button } from "@/components/ui/button";
import { useAppSettings } from "@/hooks/use-settings";
import { useSidebarHostServerId } from "@/provider-usage/sidebar-bar";
import { useHosts } from "@/runtime/host-runtime";
import { HostPerformanceDetailSheet } from "./detail-sheet";
import { calculateBusiestGpuPercent, calculateMemoryPercent, formatPercent } from "./format";
import { resolveTargetHostServerId } from "./model";
import { useHostPerformance } from "./use-host-performance";

export interface SidebarHostPerformanceBarProps {
  visible?: boolean;
}

export const SidebarHostPerformanceBar = memo(function SidebarHostPerformanceBar({
  visible = true,
}: SidebarHostPerformanceBarProps) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const isRetainedPanelActive = useRetainedPanelActive();

  const [explicitServerId, setExplicitServerId] = useState<string | null>(null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isHostPickerOpen, setIsHostPickerOpen] = useState(false);
  const [isRowHovered, setIsRowHovered] = useState(false);
  const hostPickerAnchorRef = useRef<View>(null);

  const defaultServerId = useSidebarHostServerId();
  const hosts = useHosts();
  const availableHostServerIds = useMemo(() => hosts.map((h) => h.serverId), [hosts]);

  const targetServerId = useMemo(
    () =>
      resolveTargetHostServerId({
        explicitServerId,
        defaultServerId,
        availableHostServerIds,
      }),
    [explicitServerId, defaultServerId, availableHostServerIds],
  );

  const targetHost = useMemo(
    () => hosts.find((h) => h.serverId === targetServerId) ?? null,
    [hosts, targetServerId],
  );

  const hostOptions = useMemo(
    () => hosts.map((h) => ({ serverId: h.serverId, label: h.label })),
    [hosts],
  );

  const isFeatureEnabled = settings.showHostPerformance;
  const isEffectiveVisible = Boolean(visible && isFeatureEnabled);

  const { view, retry } = useHostPerformance(targetServerId, {
    visible: isEffectiveVisible,
  });

  const handleOpenDetail = useCallback(() => {
    setIsDetailOpen(true);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setIsDetailOpen(false);
  }, []);

  const handleOpenHostPicker = useCallback(() => {
    setIsHostPickerOpen(true);
  }, []);

  const handleSelectHost = useCallback((serverId: string) => {
    setExplicitServerId(serverId);
  }, []);

  const handleHoverIn = useCallback(() => setIsRowHovered(true), []);
  const handleHoverOut = useCallback(() => setIsRowHovered(false), []);

  if (!isFeatureEnabled || !targetServerId) {
    return null;
  }

  const isModalAllowed = Boolean(visible && isRetainedPanelActive);
  const isSheetVisible = isDetailOpen && isModalAllowed;
  const isPickerOpen = isHostPickerOpen && isModalAllowed;
  const isMultiHost = hosts.length > 1;
  const metricSlotStyle = isMultiHost ? styles.metricSlotStacked : styles.metricSlotInline;

  let content = null;
  if (view.kind === "unsupported") {
    content = (
      <Text style={styles.statusNotice} numberOfLines={1}>
        {t("hostPerformance.hostUpgradeRequired")}
      </Text>
    );
  } else if (view.kind === "error") {
    content = (
      <Text style={styles.statusNotice} numberOfLines={1}>
        {view.message}
      </Text>
    );
  } else if (view.kind === "loading") {
    content = (
      <Text style={styles.statusNotice} numberOfLines={1}>
        {t("common.states.loading")}
      </Text>
    );
  } else if (view.isStale) {
    content = (
      <Text style={styles.statusNotice} numberOfLines={1}>
        {t("hostPerformance.stale")}
      </Text>
    );
  } else {
    const snapshot = view.snapshot;
    const cpuPercent = formatPercent(snapshot.sample.cpu.utilizationPercent);
    const ramPercent = formatPercent(calculateMemoryPercent(snapshot.sample.memory));

    const gpuStatus = snapshot.sample.gpus.status;
    const showGpu = gpuStatus !== "none";
    let gpuPercent = "-";
    if (gpuStatus === "available") {
      gpuPercent = formatPercent(calculateBusiestGpuPercent(snapshot.sample.gpus));
    }

    content = (
      <View style={styles.slotsContainer}>
        <View style={metricSlotStyle} testID="sidebar-host-performance-cpu">
          <Text style={styles.slotLabel}>{t("hostPerformance.cpu")}</Text>
          <Text style={styles.slotValue}>{cpuPercent}</Text>
        </View>

        <View style={metricSlotStyle} testID="sidebar-host-performance-ram">
          <Text style={styles.slotLabel}>{t("hostPerformance.ram")}</Text>
          <Text style={styles.slotValue}>{ramPercent}</Text>
        </View>

        {showGpu ? (
          <View style={metricSlotStyle} testID="sidebar-host-performance-gpu">
            <Text style={styles.slotLabel}>{t("hostPerformance.gpu")}</Text>
            <Text style={styles.slotValue}>{gpuPercent}</Text>
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View
      style={styles.container}
      testID="sidebar-host-performance"
      nativeID="sidebar-host-performance"
    >
      {isMultiHost ? (
        <HostPicker
          hosts={hostOptions}
          value={targetServerId}
          onSelect={handleSelectHost}
          open={isPickerOpen}
          onOpenChange={setIsHostPickerOpen}
          anchorRef={hostPickerAnchorRef}
          searchable={false}
          title={t("hostPerformance.selectHost")}
          desktopPlacement="bottom-start"
        >
          <View ref={hostPickerAnchorRef} collapsable={false}>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={Server}
              onPress={handleOpenHostPicker}
              style={styles.hostButton}
              textStyle={styles.hostButtonText}
              numberOfLines={1}
              accessibilityLabel={t("hostPerformance.selectHost")}
              testID="sidebar-host-performance-picker"
            >
              {targetHost?.label ?? targetServerId}
            </Button>
          </View>
        </HostPicker>
      ) : null}

      <Pressable
        onPress={handleOpenDetail}
        onHoverIn={handleHoverIn}
        onHoverOut={handleHoverOut}
        style={[styles.metricsRow, isRowHovered ? styles.metricsRowHovered : null]}
        accessibilityRole="button"
        accessibilityLabel={t("hostPerformance.title")}
        testID="sidebar-host-performance-button"
      >
        {content}
      </Pressable>

      <HostPerformanceDetailSheet
        visible={isSheetVisible}
        onClose={handleCloseDetail}
        targetServerId={targetServerId}
        onSelectHost={handleSelectHost}
        view={view}
        onRetry={retry}
      />
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
    gap: theme.spacing[1.5],
  },
  hostButton: {
    paddingHorizontal: theme.spacing[1],
    width: 96,
  },
  hostButtonText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    minWidth: 0,
    flexShrink: 1,
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
  slotsContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[1],
  },
  metricSlotInline: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[1],
  },
  metricSlotStacked: {
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
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
    minWidth: 38,
    textAlign: "right",
  },
  statusNotice: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flex: 1,
    textAlign: "center",
  },
}));
