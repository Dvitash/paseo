import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { RefreshCw, Server } from "lucide-react-native";
import type { HostPerformanceSnapshot } from "@getpaseo/protocol/host-performance";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { HostStatusDot } from "@/components/host-status-dot";
import { HostPicker } from "@/components/hosts/host-picker";
import { Button } from "@/components/ui/button";
import { useHosts } from "@/runtime/host-runtime";
import {
  calculateBusiestGpuPercent,
  calculateMemoryPercent,
  formatBytes,
  formatMemoryUsage,
  formatPercent,
} from "./format";
import { TrendChart } from "./trend-chart";
import type { HostPerformanceView } from "./types";

export interface HostPerformanceDetailSheetProps {
  visible: boolean;
  onClose: () => void;
  targetServerId: string | null;
  onSelectHost: (serverId: string) => void;
  view: HostPerformanceView;
  onRetry: () => void;
}

export const HostPerformanceDetailSheet = memo(function HostPerformanceDetailSheet({
  visible,
  onClose,
  targetServerId,
  onSelectHost,
  view,
  onRetry,
}: HostPerformanceDetailSheetProps) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const [isHostPickerOpen, setIsHostPickerOpen] = useState(false);
  const hostPickerAnchorRef = useRef<View>(null);

  const targetHost = useMemo(
    () => hosts.find((h) => h.serverId === targetServerId) ?? null,
    [hosts, targetServerId],
  );

  const hostOptions = useMemo(
    () => hosts.map((h) => ({ serverId: h.serverId, label: h.label })),
    [hosts],
  );

  const header = useMemo(
    () => ({
      title: t("hostPerformance.title"),
    }),
    [t],
  );

  const handleOpenHostPicker = useCallback(() => {
    setIsHostPickerOpen(true);
  }, []);

  const getCpuPercent = useCallback(
    (pt: HostPerformanceSnapshot["history"][number]) => pt.cpuPercent,
    [],
  );
  const getMemoryPercent = useCallback(
    (pt: HostPerformanceSnapshot["history"][number]) => pt.memoryPercent,
    [],
  );
  const getGpuPercent = useCallback(
    (pt: HostPerformanceSnapshot["history"][number]) => pt.gpuPercent,
    [],
  );

  let body = null;
  if (view.kind === "unsupported") {
    body = (
      <View style={styles.stateCard}>
        <Text style={styles.stateTitle}>{t("hostPerformance.title")}</Text>
        <Text style={styles.stateMessage}>{t("hostPerformance.hostUpgradeRequired")}</Text>
      </View>
    );
  } else if (view.kind === "error") {
    body = (
      <View style={styles.stateCard}>
        <Text style={styles.stateTitle}>{t("hostPerformance.errorTitle")}</Text>
        <Text style={styles.stateMessage}>{view.message}</Text>
        {view.canRetry ? (
          <Button
            variant="secondary"
            size="sm"
            onPress={onRetry}
            disabled={view.isRetrying}
            loading={view.isRetrying}
            leftIcon={RefreshCw}
            style={styles.retryButton}
            testID="host-performance-retry-button"
          >
            {t("hostPerformance.retry")}
          </Button>
        ) : null}
      </View>
    );
  } else if (view.kind === "loading") {
    body = (
      <View style={styles.stateCard}>
        <Text style={styles.stateMessage}>{t("common.states.loading")}</Text>
      </View>
    );
  } else {
    const snapshot = view.snapshot;
    const cpuValue = snapshot.sample.cpu.utilizationPercent;
    const ramValue = calculateMemoryPercent(snapshot.sample.memory);
    const gpus = snapshot.sample.gpus;

    let gpuContent = null;
    if (gpus.status === "none") {
      gpuContent = (
        <View style={styles.metricCard}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{t("hostPerformance.gpu")}</Text>
            <Text style={styles.statSecondary}>{t("hostPerformance.noGpu")}</Text>
          </View>
        </View>
      );
    } else if (gpus.status === "unavailable") {
      gpuContent = (
        <View style={styles.metricCard}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{t("hostPerformance.gpu")}</Text>
            <Text style={styles.statSecondary}>{t("hostPerformance.gpuUnavailable")}</Text>
          </View>
        </View>
      );
    } else {
      const busiestPercent = calculateBusiestGpuPercent(gpus);
      const isMultiGpu = gpus.devices.length > 1;

      gpuContent = (
        <View style={styles.metricCard}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{t("hostPerformance.gpu")}</Text>
            <View style={styles.statGroup}>
              {isMultiGpu ? (
                <Text style={styles.statSecondary}>
                  {t("hostPerformance.busiestGpu")}: {formatPercent(busiestPercent)}
                </Text>
              ) : null}
              {isMultiGpu ? (
                <Text style={styles.statSecondary}>
                  {t("hostPerformance.devices", { count: gpus.devices.length })}
                </Text>
              ) : null}
            </View>
          </View>

          {gpus.devices.map((device) => {
            const memoryText = device.memory
              ? `${formatBytes(device.memory.usedBytes)} / ${formatBytes(device.memory.totalBytes)}`
              : t("hostPerformance.memoryUnavailable");
            return (
              <View key={device.id} style={styles.gpuDeviceRow}>
                <View style={styles.gpuDeviceInfo}>
                  <Text style={styles.gpuDeviceName} numberOfLines={1}>
                    {device.name}
                  </Text>
                  <Text style={styles.gpuDeviceMemory}>{memoryText}</Text>
                </View>
                <Text style={styles.gpuDevicePercent}>
                  {formatPercent(device.utilizationPercent)}
                </Text>
              </View>
            );
          })}

          <TrendChart
            title={t("hostPerformance.trendLastMinute")}
            points={snapshot.history}
            getValue={getGpuPercent}
            testID="host-performance-gpu-trend"
          />
        </View>
      );
    }

    body = (
      <View style={styles.metricsContainer}>
        {view.isStale ? (
          <View style={styles.staleBanner}>
            <Text style={styles.staleBannerText}>{t("hostPerformance.stale")}</Text>
          </View>
        ) : null}

        <View style={styles.metricCard}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{t("hostPerformance.cpu")}</Text>
            <View style={styles.statGroup}>
              <Text style={styles.statPrimary}>{formatPercent(cpuValue)}</Text>
              <Text style={styles.statSecondary}>
                {t("hostPerformance.cores", { count: snapshot.sample.cpu.logicalCores })}
              </Text>
            </View>
          </View>
          <TrendChart
            title={t("hostPerformance.trendLastMinute")}
            points={snapshot.history}
            getValue={getCpuPercent}
            testID="host-performance-cpu-trend"
          />
        </View>

        <View style={styles.metricCard}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{t("hostPerformance.memory")}</Text>
            <View style={styles.statGroup}>
              <Text style={styles.statPrimary}>{formatPercent(ramValue)}</Text>
              <Text style={styles.statSecondary}>{formatMemoryUsage(snapshot.sample.memory)}</Text>
            </View>
          </View>
          <TrendChart
            title={t("hostPerformance.trendLastMinute")}
            points={snapshot.history}
            getValue={getMemoryPercent}
            testID="host-performance-memory-trend"
          />
        </View>

        {gpuContent}
      </View>
    );
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      snapPoints={["65%", "90%"]}
      contentStyle={styles.content}
      testID="host-performance-detail-sheet"
    >
      <View style={styles.hostHeaderRow}>
        <View style={styles.hostIdentity}>
          {targetServerId ? (
            <HostStatusDot serverId={targetServerId} />
          ) : (
            <Server size={14} color="#71717a" />
          )}
          <Text style={styles.hostName} numberOfLines={1}>
            {targetHost?.label ?? targetServerId ?? t("hostPerformance.selectHost")}
          </Text>
        </View>

        {hosts.length > 1 ? (
          <HostPicker
            hosts={hostOptions}
            value={targetServerId ?? ""}
            onSelect={onSelectHost}
            open={visible && isHostPickerOpen}
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
                accessibilityLabel={t("hostPerformance.selectHost")}
                testID="host-performance-host-picker-trigger"
              >
                {t("hostPerformance.selectHost")}
              </Button>
            </View>
          </HostPicker>
        ) : null}
      </View>

      {body}
    </AdaptiveModalSheet>
  );
});

const styles = StyleSheet.create((theme) => ({
  content: {
    paddingVertical: theme.spacing[4],
    gap: theme.spacing[4],
  },
  hostHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingBottom: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  hostIdentity: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  hostName: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  stateCard: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  stateTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  stateMessage: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  retryButton: {
    alignSelf: "flex-start",
    marginTop: theme.spacing[2],
  },
  metricsContainer: {
    gap: theme.spacing[4],
  },
  staleBanner: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignSelf: "flex-start",
  },
  staleBannerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  metricCard: {
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    gap: theme.spacing[3],
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  cardTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  statGroup: {
    flexDirection: "row",
    alignItems: "baseline",
    gap: theme.spacing[2],
  },
  statPrimary: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  },
  statSecondary: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  gpuDeviceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  gpuDeviceInfo: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  gpuDeviceName: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  gpuDeviceMemory: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  gpuDevicePercent: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  },
}));
