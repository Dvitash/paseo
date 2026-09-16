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
  awaitingNewTurnUsage: boolean;
}

export function createThreadTokenUsageAccumulator(): ThreadTokenUsageAccumulator {
  return {
    turnKey: null,
    completed: {},
    current: {},
    awaitingNewTurnUsage: false,
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
  const inputTokens = reported.inputTokens ?? current.inputTokens;
  const cachedInputTokens = reported.cachedInputTokens ?? current.cachedInputTokens;
  const outputTokens = reported.outputTokens ?? current.outputTokens;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

function addUsage(a: TokenUsageValues, b: TokenUsageValues): TokenUsageValues {
  const inputTokens = addOptional(a.inputTokens, b.inputTokens);
  const cachedInputTokens = addOptional(a.cachedInputTokens, b.cachedInputTokens);
  const outputTokens = addOptional(a.outputTokens, b.outputTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

/**
 * Accumulates provider-reported per-turn usage into a thread total while keeping
 * the active turn live. `turnKey` is the agent's last user-message timestamp.
 *
 * A new turn can become visible before its first usage event. In that case the
 * store still contains the previous completed turn, so ignore that stale snapshot
 * until the model-turn tracker reports the new turn as running.
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
      awaitingNewTurnUsage: false,
    };
  }

  const turnChanged =
    previous.turnKey !== null && turnKey !== null && turnKey !== previous.turnKey;
  if (turnChanged) {
    const completed = addUsage(previous.completed, previous.current);
    const hasNewTurnSnapshot = usage?.modelTurn?.status === "running";
    return {
      turnKey,
      completed,
      current: hasNewTurnSnapshot ? mergeReportedUsage({}, reported) : {},
      awaitingNewTurnUsage: !hasNewTurnSnapshot,
    };
  }

  if (previous.awaitingNewTurnUsage && usage?.modelTurn?.status !== "running") {
    return {
      ...previous,
      turnKey: turnKey ?? previous.turnKey,
    };
  }

  return {
    turnKey: turnKey ?? previous.turnKey,
    completed: previous.completed,
    current: mergeReportedUsage(previous.current, reported),
    awaitingNewTurnUsage: false,
  };
}

export function getThreadTokenUsage(accumulator: ThreadTokenUsageAccumulator): TokenUsageValues {
  return addUsage(accumulator.completed, accumulator.current);
}

export function hasTokenUsage(usage: TokenUsageValues): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.cachedInputTokens !== undefined ||
    usage.outputTokens !== undefined
  );
}
