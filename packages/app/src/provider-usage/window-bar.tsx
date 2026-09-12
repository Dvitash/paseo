import { useMemo } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { clampPct, formatPct, formatResetLabel } from "./format";
import { deriveTone } from "./tone";
import type { ProviderUsageTone, ProviderUsageWindow } from "./types";

function resolveUsedPct(window: ProviderUsageWindow): number | null {
  if (typeof window.usedPct === "number" && Number.isFinite(window.usedPct)) {
    return window.usedPct;
  }
  if (typeof window.remainingPct === "number" && Number.isFinite(window.remainingPct)) {
    return 100 - window.remainingPct;
  }
  return null;
}

function resolveRemainingPct(window: ProviderUsageWindow): number | null {
  if (typeof window.remainingPct === "number" && Number.isFinite(window.remainingPct)) {
    return window.remainingPct;
  }
  if (typeof window.usedPct === "number" && Number.isFinite(window.usedPct)) {
    return 100 - window.usedPct;
  }
  return null;
}

function fillToneStyle(tone: ProviderUsageTone) {
  switch (tone) {
    case "ok":
      return styles.fillOk;
    case "warning":
      return styles.fillWarning;
    case "danger":
      return styles.fillDanger;
    default:
      return styles.fillDefault;
  }
}

export function ProviderUsageWindowBar({ window }: { window: ProviderUsageWindow }) {
  const usedPct = resolveUsedPct(window);
  const remainingPct = resolveRemainingPct(window);
  const tone = window.tone ?? deriveTone(usedPct);

  const fillWidth = clampPct(remainingPct ?? 0);
  const fillStyle = useMemo<StyleProp<ViewStyle>>(
    () => [styles.fill, fillToneStyle(tone), { width: `${fillWidth}%` }],
    [fillWidth, tone],
  );

  const isAtRisk = window.runsOutAt != null && window.shortfallPct != null;
  const trailing = isAtRisk
    ? `runs out ${formatResetLabel(window.runsOutAt)?.replace("resets ", "") ?? ""}`.trim()
    : formatResetLabel(window.resetsAt);

  return (
    <View style={styles.container}>
      <View style={styles.labelRow}>
        <Text style={styles.label} numberOfLines={1}>
          {window.label}
        </Text>
        <Text style={styles.value}>
          {remainingPct != null ? `${formatPct(remainingPct)} remaining` : "—"}
          {trailing ? (
            <Text style={isAtRisk ? styles.atRisk : styles.reset}>{` · ${trailing}`}</Text>
          ) : null}
        </Text>
      </View>
      <View style={styles.track}>
        <View style={fillStyle} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: 3,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    flexShrink: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  value: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  reset: {
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
  },
  atRisk: {
    color: theme.colors.statusDanger,
    fontWeight: theme.fontWeight.normal,
  },
  track: {
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  fill: {
    height: 4,
    borderRadius: 2,
  },
  fillDefault: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  fillOk: {
    backgroundColor: theme.colors.statusSuccess,
  },
  fillWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  fillDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
}));
