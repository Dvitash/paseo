import { memo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { settingsStyles } from "@/styles/settings";
import { formatTokenStat } from "./format";
import type { HostTokenUsageRangeItem } from "./types";

export interface TokenUsageCardProps {
  rangeData: HostTokenUsageRangeItem;
  testID?: string;
}

export const TokenUsageCard = memo(function TokenUsageCard({
  rangeData,
  testID,
}: TokenUsageCardProps) {
  const { t } = useTranslation();

  return (
    <View style={[settingsStyles.card, styles.card]} testID={testID}>
      <View style={styles.column} testID="token-usage-input">
        <Text style={styles.label}>{t("tokenUsage.input")}</Text>
        <Text style={styles.value}>{formatTokenStat(rangeData.inputTokens)}</Text>
      </View>

      <View style={styles.column} testID="token-usage-cache-read">
        <Text style={styles.label}>{t("tokenUsage.cacheRead")}</Text>
        <Text style={styles.value}>{formatTokenStat(rangeData.cacheReadTokens)}</Text>
      </View>

      <View style={styles.column} testID="token-usage-output">
        <Text style={styles.label}>{t("tokenUsage.output")}</Text>
        <Text style={styles.value}>{formatTokenStat(rangeData.outputTokens)}</Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
  },
  column: {
    flex: 1,
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: "700",
    letterSpacing: -0.5,
  },
}));
