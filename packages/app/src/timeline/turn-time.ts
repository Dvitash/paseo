import type { StreamItem } from "@/types/stream";
import { startsNewTurn } from "@/agent-stream/turn-membership";

export interface TurnTiming {
  completedAt: Date;
  durationMs: number | null;
}

export interface StreamTurnTiming {
  byAssistantId: Map<string, TurnTiming>;
  runningStartedAt: Date | null;
}
interface TailScanContinuation {
  completedByAssistantId: Map<string, TurnTiming>;
  pendingCurrentUserAt: Date | null;
  pendingCurrentLastItemAt: Date | null;
  pendingCurrentAssistantIds: string[];
  previousItem: StreamItem | null;
  fullCompletedByAssistantId: Map<string, TurnTiming>;
}

const EMPTY_TIMING_MAP = new Map<string, TurnTiming>();

const EMPTY_TAIL_CONTINUATION: TailScanContinuation = {
  completedByAssistantId: EMPTY_TIMING_MAP,
  pendingCurrentUserAt: null,
  pendingCurrentLastItemAt: null,
  pendingCurrentAssistantIds: [],
  previousItem: null,
  fullCompletedByAssistantId: EMPTY_TIMING_MAP,
};

const tailContinuationCache = new WeakMap<StreamItem[], TailScanContinuation>();

function scanTail(tail: StreamItem[]): TailScanContinuation {
  const completedByAssistantId = new Map<string, TurnTiming>();
  let currentUserAt: Date | null = null;
  let currentLastItemAt: Date | null = null;
  let currentAssistantIds: string[] = [];
  let previousItem: StreamItem | null = null;

  for (const item of tail) {
    if (startsNewTurn(item, previousItem)) {
      if (currentLastItemAt && currentAssistantIds.length > 0) {
        const timing: TurnTiming = {
          completedAt: currentLastItemAt,
          durationMs: currentUserAt
            ? Math.max(0, currentLastItemAt.getTime() - currentUserAt.getTime())
            : null,
        };
        for (const id of currentAssistantIds) {
          completedByAssistantId.set(id, timing);
        }
      }
      currentUserAt = item.kind === "user_message" ? item.timestamp : null;
      currentLastItemAt = null;
      currentAssistantIds = [];
    }
    currentLastItemAt = item.timestamp;
    if (item.kind === "assistant_message") {
      currentAssistantIds.push(item.id);
    }
    previousItem = item;
  }

  let fullCompletedByAssistantId = completedByAssistantId;
  if (currentLastItemAt && currentAssistantIds.length > 0) {
    fullCompletedByAssistantId = new Map(completedByAssistantId);
    const timing: TurnTiming = {
      completedAt: currentLastItemAt,
      durationMs: currentUserAt
        ? Math.max(0, currentLastItemAt.getTime() - currentUserAt.getTime())
        : null,
    };
    for (const id of currentAssistantIds) {
      fullCompletedByAssistantId.set(id, timing);
    }
  }

  return {
    completedByAssistantId,
    pendingCurrentUserAt: currentUserAt,
    pendingCurrentLastItemAt: currentLastItemAt,
    pendingCurrentAssistantIds: currentAssistantIds,
    previousItem,
    fullCompletedByAssistantId,
  };
}

export function deriveStreamTurnTiming(params: {
  isTurnActive: boolean;
  activeTurnStartedAt: Date | null;
  tail: StreamItem[];
  head: StreamItem[];
}): StreamTurnTiming {
  let continuation: TailScanContinuation;
  if (params.tail.length === 0) {
    continuation = EMPTY_TAIL_CONTINUATION;
  } else {
    const cached = tailContinuationCache.get(params.tail);
    if (cached) {
      continuation = cached;
    } else {
      continuation = scanTail(params.tail);
      tailContinuationCache.set(params.tail, continuation);
    }
  }

  if (params.head.length === 0) {
    if (!params.isTurnActive) {
      return {
        byAssistantId: continuation.fullCompletedByAssistantId,
        runningStartedAt: null,
      };
    }
    return {
      byAssistantId: continuation.completedByAssistantId,
      runningStartedAt: params.activeTurnStartedAt,
    };
  }

  let baseCompletedMap = continuation.completedByAssistantId;
  let currentUserAt: Date | null;
  let currentLastItemAt: Date | null;
  let currentAssistantIds: string[];
  let previousItem: StreamItem | null;
  let headStartIndex = 0;

  if (startsNewTurn(params.head[0], continuation.previousItem)) {
    baseCompletedMap = continuation.fullCompletedByAssistantId;
    const firstHeadItem = params.head[0];
    currentUserAt = firstHeadItem.kind === "user_message" ? firstHeadItem.timestamp : null;
    currentLastItemAt = firstHeadItem.timestamp;
    currentAssistantIds = firstHeadItem.kind === "assistant_message" ? [firstHeadItem.id] : [];
    previousItem = firstHeadItem;
    headStartIndex = 1;
  } else {
    currentUserAt = continuation.pendingCurrentUserAt;
    currentLastItemAt = continuation.pendingCurrentLastItemAt;
    currentAssistantIds =
      continuation.pendingCurrentAssistantIds.length > 0
        ? [...continuation.pendingCurrentAssistantIds]
        : [];
    previousItem = continuation.previousItem;
    headStartIndex = 0;
  }

  let byAssistantId: Map<string, TurnTiming> | null = null;

  const flushCompletedTurn = () => {
    if (!currentLastItemAt || currentAssistantIds.length === 0) {
      return;
    }
    if (!byAssistantId) {
      byAssistantId = new Map(baseCompletedMap);
    }
    const timing: TurnTiming = {
      completedAt: currentLastItemAt,
      durationMs: currentUserAt
        ? Math.max(0, currentLastItemAt.getTime() - currentUserAt.getTime())
        : null,
    };
    for (const id of currentAssistantIds) {
      byAssistantId.set(id, timing);
    }
  };

  for (let i = headStartIndex; i < params.head.length; i++) {
    const item = params.head[i];
    if (startsNewTurn(item, previousItem)) {
      flushCompletedTurn();
      currentUserAt = item.kind === "user_message" ? item.timestamp : null;
      currentLastItemAt = null;
      currentAssistantIds = [];
    }
    currentLastItemAt = item.timestamp;
    if (item.kind === "assistant_message") {
      currentAssistantIds.push(item.id);
    }
    previousItem = item;
  }

  const runningStartedAt = params.isTurnActive ? params.activeTurnStartedAt : null;
  if (!params.isTurnActive) {
    flushCompletedTurn();
  }

  return {
    byAssistantId: byAssistantId ?? baseCompletedMap,
    runningStartedAt,
  };
}
