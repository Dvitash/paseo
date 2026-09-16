import type { AgentUsage } from "@getpaseo/protocol/agent-types";

export interface TokenUsageValues {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface ThreadTokenUsageAccumulator {
  turnKey: number | null;
  completed: TokenUsageValues;
  current: TokenUsageValues;
}

export function createThreadTokenUsageAccumulator(): ThreadTokenUsageAccumulator {
  return {
    turnKey: null,
    completed: {},
    current: {},
  };
}

function reportedTokenUsage(usage: AgentUsage | undefined): TokenUsageValues {
  if (!usage) return {};
  return {
    ...(typeof usage.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage.cachedInputTokens === "number"
      ? { cachedInputTokens: usage.cachedInputTokens }
      : {}),
    ...(typeof usage.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
  };
}

function mergeReportedUsage(
  current: TokenUsageValues,
  reported: TokenUsageValues,
): TokenUsageValues {
  return {
    ...(current.inputTokens !== undefined || reported.inputTokens !== undefined
      ? { inputTokens: reported.inputTokens ?? current.inputTokens }
      : {}),
    ...(current.cachedInputTokens !== undefined || reported.cachedInputTokens !== undefined
      ? { cachedInputTokens: reported.cachedInputTokens ?? current.cachedInputTokens }
      : {}),
    ...(current.outputTokens !== undefined || reported.outputTokens !== undefined
      ? { outputTokens: reported.outputTokens ?? current.outputTokens }
      : {}),
  };
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function addUsage(a: TokenUsageValues, b: TokenUsageValues): TokenUsageValues {
  return {
    ...(addOptional(a.inputTokens, b.inputTokens) !== undefined
      ? { inputTokens: addOptional(a.inputTokens, b.inputTokens) }
      : {}),
    ...(addOptional(a.cachedInputTokens, b.cachedInputTokens) !== undefined
      ? { cachedInputTokens: addOptional(a.cachedInputTokens, b.cachedInputTokens) }
      : {}),
    ...(addOptional(a.outputTokens, b.outputTokens) !== undefined
      ? { outputTokens: addOptional(a.outputTokens, b.outputTokens) }
      : {}),
  };
}

/**
 * Accumulates provider-reported per-turn usage into a thread total while keeping
 * the active turn live. `turnKey` is the agent's last user-message timestamp.
 *
 * A new turn can become visible before its first usage event. In that case the
 * store still contains the previous completed turn, so do not seed the new turn
 * from a completed model-turn snapshot. The next usage update for the same turn
 * will populate it normally.
 */
export function updateThreadTokenUsage(
  previous: ThreadTokenUsageAccumulator,
  turnKey: number | null,
  usage: AgentUsage | undefined,
): ThreadTokenUsageAccumulator {
  const reported = reportedTokenUsage(usage);

  if (previous.turnKey !== null && turnKey !== null && turnKey < previous.turnKey) {
    return {
      turnKey,
      completed: {},
      current: mergeReportedUsage({}, reported),
    };
  }

  const turnChanged =
    previous.turnKey !== null && turnKey !== null && turnKey !== previous.turnKey;
  if (!turnChanged) {
    return {
      turnKey: turnKey ?? previous.turnKey,
      completed: previous.completed,
      current: mergeReportedUsage(previous.current, reported),
    };
  }

  const completed = addUsage(previous.completed, previous.current);
  const shouldSeedNewTurn = usage?.modelTurn?.status === "running";
  return {
    turnKey,
    completed,
    current: shouldSeedNewTurn ? mergeReportedUsage({}, reported) : {},
  };
}

export function getThreadTokenUsage(
  accumulator: ThreadTokenUsageAccumulator,
): TokenUsageValues {
  return addUsage(accumulator.completed, accumulator.current);
}

export function hasTokenUsage(usage: TokenUsageValues): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.cachedInputTokens !== undefined ||
    usage.outputTokens !== undefined
  );
}
