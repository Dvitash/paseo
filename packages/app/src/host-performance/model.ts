import type { HostPerformanceHistoryPoint } from "@getpaseo/protocol/host-performance";

export interface ResolveTargetHostInput {
  explicitServerId: string | null | undefined;
  defaultServerId: string | null | undefined;
  availableHostServerIds: readonly string[];
}

export function resolveTargetHostServerId(input: ResolveTargetHostInput): string | null {
  if (input.explicitServerId && input.availableHostServerIds.includes(input.explicitServerId)) {
    return input.explicitServerId;
  }
  if (input.defaultServerId && input.availableHostServerIds.includes(input.defaultServerId)) {
    return input.defaultServerId;
  }
  return input.availableHostServerIds[0] ?? null;
}

export type SparklineSegment =
  | { type: "line"; key: string; path: string }
  | { type: "dot"; key: string; cx: number; cy: number };

export interface GenerateSparklineInput {
  points: readonly HostPerformanceHistoryPoint[];
  getValue: (point: HostPerformanceHistoryPoint) => number | null;
  width: number;
  height: number;
  timeWindowMs?: number;
  now?: number;
  maxGapMs?: number;
}

export function generateSparklineSegments(input: GenerateSparklineInput): SparklineSegment[] {
  const { points, getValue, width, height, timeWindowMs = 60_000, maxGapMs = 6_000 } = input;

  if (points.length === 0 || width <= 0 || height <= 0) {
    return [];
  }

  const latestSampleTime = points.reduce((max, p) => (p.sampledAt > max ? p.sampledAt : max), 0);
  const now = input.now ?? (latestSampleTime > 0 ? latestSampleTime : Date.now());
  const windowStart = now - timeWindowMs;

  const validSortedPoints = [...points]
    .filter((p) => p.sampledAt >= windowStart - 5_000 && p.sampledAt <= now + 5_000)
    .sort((a, b) => a.sampledAt - b.sampledAt);

  const segments: SparklineSegment[] = [];
  let currentRun: Array<{ x: number; y: number; sampledAt: number }> = [];

  const flushRun = () => {
    if (currentRun.length === 1) {
      segments.push({
        type: "dot",
        key: `dot-${currentRun[0].sampledAt}`,
        cx: Number(currentRun[0].x.toFixed(1)),
        cy: Number(currentRun[0].y.toFixed(1)),
      });
    } else if (currentRun.length > 1) {
      const [first, ...rest] = currentRun;
      const pathCommands = [
        `M ${first.x.toFixed(1)} ${first.y.toFixed(1)}`,
        ...rest.map((pt) => `L ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`),
      ].join(" ");
      segments.push({
        type: "line",
        key: `line-${first.sampledAt}`,
        path: pathCommands,
      });
    }
    currentRun = [];
  };

  for (const point of validSortedPoints) {
    const rawValue = getValue(point);
    if (rawValue == null || !Number.isFinite(rawValue) || rawValue < 0 || rawValue > 100) {
      flushRun();
      continue;
    }

    const previousPoint = currentRun[currentRun.length - 1];
    if (previousPoint && point.sampledAt - previousPoint.sampledAt > maxGapMs) {
      flushRun();
    }

    const clampedTime = Math.max(windowStart, Math.min(now, point.sampledAt));
    const x = ((clampedTime - windowStart) / timeWindowMs) * width;
    const y = height - (rawValue / 100) * height;

    currentRun.push({ x, y, sampledAt: point.sampledAt });
  }

  flushRun();
  return segments;
}
