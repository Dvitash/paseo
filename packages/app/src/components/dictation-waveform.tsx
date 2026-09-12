import { memo, useEffect, useState } from "react";
import { View } from "react-native";
import ReanimatedAnimated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";

const DEFAULT_BAR_COUNT = 28;
const BAR_WIDTH = 2;
const BAR_GAP = 2;
const MIN_BAR_HEIGHT = 4;
const MAX_BAR_HEIGHT = 30;
const TRACK_HEIGHT = 30;
const ANIMATION_DURATION_MS = 90;
/** Speech RMS often peaks well below 1; the exponent lifts quiet samples so the row feels lively. */
const VOLUME_EXPONENT = 0.7;

interface DictationWaveformProps {
  /** Latest RMS level, 0..1. Newest sample renders on the right. */
  volume: number;
  /** Bar color — passed in so this component never touches unistyles hooks. */
  color: string;
  barCount?: number;
}

function barTargetHeight(sample: number): number {
  const clamped = Math.min(1, Math.max(0, sample));
  return MIN_BAR_HEIGHT + (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT) * clamped ** VOLUME_EXPONENT;
}

interface WaveformBarProps {
  sample: number;
  color: string;
}

const WaveformBar = memo(function WaveformBar({ sample, color }: WaveformBarProps) {
  const animatedHeight = useSharedValue(barTargetHeight(sample));

  useEffect(() => {
    animatedHeight.value = withTiming(barTargetHeight(sample), {
      duration: ANIMATION_DURATION_MS,
      easing: Easing.out(Easing.quad),
    });
  }, [animatedHeight, sample]);

  const animatedStyle = useAnimatedStyle(() => ({ height: animatedHeight.value }));

  return (
    <ReanimatedAnimated.View style={[styles.bar, { backgroundColor: color }, animatedStyle]} />
  );
});

/**
 * Whisper-Flow-style scrolling waveform: a rolling window of recent volume samples where the
 * newest sample sits on the right and older samples scroll left.
 */
export function DictationWaveform({
  volume,
  color,
  barCount = DEFAULT_BAR_COUNT,
}: DictationWaveformProps) {
  const count = Math.max(1, Math.round(barCount));
  const [samples, setSamples] = useState<number[]>(() => Array.from({ length: count }, () => 0));

  useEffect(() => {
    setSamples((previous) => {
      const next =
        previous.length === count ? previous.slice(1) : Array.from({ length: count - 1 }, () => 0);
      next.push(volume);
      return next;
    });
  }, [count, volume]);

  return (
    <View
      style={styles.container}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {Array.from({ length: count }, (_, index) => (
        <WaveformBar key={index} sample={samples[index] ?? 0} color={color} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: TRACK_HEIGHT,
    gap: BAR_GAP,
  },
  bar: {
    width: BAR_WIDTH,
    borderRadius: theme.borderRadius.full,
  },
}));
