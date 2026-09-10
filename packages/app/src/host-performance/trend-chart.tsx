import { memo, useCallback, useMemo, useState } from "react";
import { type LayoutChangeEvent, Text, View } from "react-native";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { HostPerformanceHistoryPoint } from "@getpaseo/protocol/host-performance";
import type { Theme } from "@/styles/theme";
import { generateSparklineSegments, type SparklineSegment } from "./model";

const CHART_HEIGHT = 40;

interface SparklineProps {
  width: number;
  segments: SparklineSegment[];
  stroke?: string;
  gridStroke?: string;
}

// Theme the SVG root, not individual SVG children: web wrappers inside <svg> do not paint.
function Sparkline({ width, segments, stroke, gridStroke }: SparklineProps) {
  return (
    <Svg width={width} height={CHART_HEIGHT} viewBox={`-2 -2 ${width} ${CHART_HEIGHT}`}>
      <Line
        x1={0}
        y1={18}
        x2={width - 4}
        y2={18}
        stroke={gridStroke}
        strokeDasharray="2 3"
        strokeWidth={1}
      />
      <Line x1={0} y1={36} x2={width - 4} y2={36} stroke={gridStroke} strokeWidth={1} />
      {segments.map((segment) => {
        if (segment.type === "line") {
          return (
            <Path
              key={segment.key}
              d={segment.path}
              fill="none"
              stroke={stroke}
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        }
        return <Circle key={segment.key} cx={segment.cx} cy={segment.cy} r={2} fill={stroke} />;
      })}
    </Svg>
  );
}

const ThemedSparkline = withUnistyles(Sparkline);
const chartColorMapping = (theme: Theme) => ({
  stroke: theme.colors.foregroundMuted,
  gridStroke: theme.colors.border,
});

interface TrendChartProps {
  title: string;
  points: readonly HostPerformanceHistoryPoint[];
  getValue: (point: HostPerformanceHistoryPoint) => number | null;
  testID: string;
}

export const TrendChart = memo(function TrendChart({
  title,
  points,
  getValue,
  testID,
}: TrendChartProps) {
  const [width, setWidth] = useState(260);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const measuredWidth = event.nativeEvent.layout.width;
    if (measuredWidth > 4) setWidth(measuredWidth);
  }, []);
  const segments = useMemo(
    () =>
      generateSparklineSegments({
        points,
        getValue,
        width: width - 4,
        height: CHART_HEIGHT - 4,
      }),
    [points, getValue, width],
  );

  return (
    <View style={styles.container} testID={testID} onLayout={handleLayout}>
      <Text style={styles.title}>{title}</Text>
      <ThemedSparkline width={width} segments={segments} uniProps={chartColorMapping} />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[1],
  },
  title: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
