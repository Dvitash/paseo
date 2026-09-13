import { memo, useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react-native";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { Alert } from "@/components/ui/alert";
import { settingsStyles } from "@/styles/settings";
import { TokenUsageCard } from "./card";
import { useTokenUsage } from "./use-token-usage";
import type { TimeRangeKey, TokenUsageView } from "./types";

const TIME_RANGE_OPTIONS: SegmentedControlOption<TimeRangeKey>[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "all", label: "All" },
];

export interface TokenUsageSettingsSectionProps {
  serverId?: string | null;
}

export const TokenUsageSettingsSection = memo(function TokenUsageSettingsSection({
  serverId,
}: TokenUsageSettingsSectionProps) {
  const { t } = useTranslation();
  const [range, setRange] = useState<TimeRangeKey>("1h");
  const { view, refresh, isRefreshing } = useTokenUsage(serverId);

  const handleRefresh = useCallback(() => {
    void refresh();
  }, [refresh]);

  const trailing = useMemo(
    () => (
      <View style={styles.trailingContainer}>
        <SegmentedControl
          options={TIME_RANGE_OPTIONS}
          value={range}
          onValueChange={setRange}
          size="sm"
          testID="token-usage-range-control"
        />
        <Button
          variant="ghost"
          size="sm"
          leftIcon={RefreshCw}
          loading={isRefreshing}
          onPress={handleRefresh}
          accessibilityLabel={t("tokenUsage.refresh")}
          testID="token-usage-refresh-button"
        >
          {t("tokenUsage.refresh")}
        </Button>
      </View>
    ),
    [range, isRefreshing, handleRefresh, t],
  );

  return (
    <SettingsSection title={t("tokenUsage.title")} testID="token-usage-section" trailing={trailing}>
      <TokenUsageBody view={view} selectedRange={range} onRefresh={handleRefresh} />
    </SettingsSection>
  );
});

function TokenUsageBody({
  view,
  selectedRange,
  onRefresh,
}: {
  view: TokenUsageView;
  selectedRange: TimeRangeKey;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();

  if (view.kind === "loading") {
    return (
      <View style={[settingsStyles.card, styles.emptyCard]}>
        <Text style={styles.emptyText}>{t("tokenUsage.loading")}</Text>
      </View>
    );
  }

  if (view.kind === "unavailable") {
    return (
      <Alert variant="warning" title={t("tokenUsage.title")} description={view.message}>
        <Button variant="outline" size="sm" onPress={onRefresh}>
          {t("tokenUsage.retry")}
        </Button>
      </Alert>
    );
  }

  if (view.kind === "error") {
    return (
      <Alert variant="error" title={t("tokenUsage.errorTitle")} description={view.message}>
        <Button variant="outline" size="sm" onPress={onRefresh}>
          {t("tokenUsage.retry")}
        </Button>
      </Alert>
    );
  }

  const rangeData = view.ranges[selectedRange];
  return <TokenUsageCard rangeData={rangeData} testID="token-usage-data-card" />;
}

const styles = StyleSheet.create((theme) => ({
  trailingContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
    justifyContent: "flex-end",
  },
  emptyCard: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
}));
