import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView as RNScrollView,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { isWeb } from "@/constants/platform";
import { getCodeInsets } from "./code-insets";
import { formatTimeoutSeconds, formatWallClockSeconds } from "@/utils/time";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

export interface DetailStyles {
  sectionFillStyle: StyleProp<ViewStyle>;
  codeBlockFillStyle: StyleProp<ViewStyle>;
  codeVerticalScrollStyle: StyleProp<ViewStyle>;
  scrollAreaFillStyle: StyleProp<ViewStyle>;
  scrollAreaStyle: StyleProp<ViewStyle>;
  jsonScrollCombined: StyleProp<ViewStyle>;
  jsonScrollErrorCombined: StyleProp<ViewStyle>;
  fullBleedContainerStyle: StyleProp<ViewStyle>;
  loadingContainerStyle: StyleProp<ViewStyle>;
  resolvedMaxHeight: number | undefined;
  shouldFill: boolean;
  isFullBleed: boolean;
}

export interface ShellDetailProps {
  command: string;
  output: string | null | undefined;
  timeoutMs?: number;
  status?: "executing" | "running" | "completed" | "failed" | "canceled";
  startedAt?: Date;
  endedAt?: Date;
  ds: DetailStyles;
}

const SHELL_WALL_CLOCK_TICK_MS = 50;

/**
 * Counts up from the moment the call was first observed and freezes at
 * `endedAt` once the call reaches a terminal status. Without timing data it
 * stays pinned at 0.00s (permission previews, hydrated rows that predate
 * startedAt tracking).
 */
function ShellWallClock({
  status,
  startedAt,
  endedAt,
}: {
  status?: ShellDetailProps["status"];
  startedAt?: Date;
  endedAt?: Date;
}) {
  const endedAtMs = endedAt?.getTime();
  const startedAtMs = startedAt?.getTime();
  const isRunning = status === "running" || status === "executing";
  const computeElapsed = useCallback(() => {
    if (isRunning) {
      return Math.max(0, Date.now() - (startedAtMs ?? Date.now()));
    }
    if (startedAtMs === undefined) {
      return 0;
    }
    return Math.max(0, (endedAtMs ?? Date.now()) - startedAtMs);
  }, [isRunning, startedAtMs, endedAtMs]);
  const [elapsedMs, setElapsedMs] = useState(computeElapsed);

  useEffect(() => {
    setElapsedMs(computeElapsed());
    if (!isRunning) {
      return;
    }
    const handle = setInterval(() => setElapsedMs(computeElapsed()), SHELL_WALL_CLOCK_TICK_MS);
    return () => clearInterval(handle);
  }, [isRunning, computeElapsed]);

  return <Text>{formatWallClockSeconds(elapsedMs)}</Text>;
}

export function ShellDetailSection({
  command,
  output,
  timeoutMs,
  status,
  startedAt,
  endedAt,
  ds,
}: ShellDetailProps) {
  const { t } = useTranslation();
  const normalizedCommand = command.replace(/\n+$/, "");
  const commandOutput = (output ?? "").replace(/^\n+/, "");
  const hasOutput = commandOutput.length > 0;
  return (
    <View style={ds.sectionFillStyle}>
      <View style={ds.codeBlockFillStyle}>
        <ScrollView
          style={ds.codeVerticalScrollStyle}
          contentContainerStyle={styles.codeVerticalContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            contentContainerStyle={styles.codeHorizontalContent}
          >
            <View style={styles.codeLine} dataSet={CODE_SURFACE_DATASET}>
              <Text selectable style={styles.scrollText}>
                <Text style={styles.shellPrompt}>$ </Text>
                {normalizedCommand}
              </Text>
              <View style={styles.shellDivider}>
                <View style={styles.shellDividerLine} />
                <Text style={styles.shellDividerLabel}>{t("toolCallDetails.output")}</Text>
                <View style={styles.shellDividerLine} />
              </View>
              {hasOutput ? (
                <Text selectable style={styles.scrollText}>
                  {commandOutput}
                </Text>
              ) : null}
            </View>
          </ScrollView>
        </ScrollView>
        <View style={styles.shellFooter}>
          <Text style={styles.shellFooterText}>
            {t("toolCallDetails.shellWallLabel")}{" "}
            <ShellWallClock status={status} startedAt={startedAt} endedAt={endedAt} />
            {timeoutMs !== undefined
              ? ` | ${t("toolCallDetails.shellTimeoutLabel")} ${timeoutMs === 0 ? t("toolCallDetails.shellTimeoutNone") : formatTimeoutSeconds(timeoutMs)}`
              : ""}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const insets = getCodeInsets(theme);
  return {
    codeVerticalContent: {
      flexGrow: 1,
      paddingBottom: insets.extraBottom,
    },
    codeHorizontalContent: {
      paddingRight: insets.extraRight,
    },
    codeLine: {
      minWidth: "100%",
      paddingHorizontal: insets.padding,
      paddingVertical: insets.padding,
    },
    scrollText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foreground,
      lineHeight: 18,
      ...(isWeb
        ? {
            whiteSpace: "pre",
            overflowWrap: "normal",
          }
        : null),
    },
    shellPrompt: {
      color: theme.colors.foregroundMuted,
    },
    shellDivider: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[3],
      marginVertical: theme.spacing[2],
    },
    shellDividerLine: {
      flex: 1,
      height: theme.borderWidth[1],
      backgroundColor: theme.colors.border,
    },
    shellDividerLabel: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foregroundMuted,
      lineHeight: 18,
    },
    shellFooter: {
      paddingHorizontal: insets.padding,
      paddingTop: theme.spacing[1],
      paddingBottom: insets.padding,
      borderTopWidth: theme.borderWidth[1],
      borderTopColor: theme.colors.border,
    },
    shellFooterText: {
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      color: theme.colors.foregroundMuted,
      lineHeight: 18,
      fontVariant: ["tabular-nums"],
    },
  };
});
