import type { AgentModelTurnUsage } from "../agent-sdk-types.js";

export interface AssistantTimingMessage {
  role?: string;
  duration?: unknown;
  ttft?: unknown;
  usage?: {
    output?: unknown;
    [key: string]: unknown;
  };
  errorMessage?: string | null;
  stopReason?: string;
}

export interface ParsedAssistantTurnMetrics {
  ttftMs: number | null;
  tokensPerSecond: number | null;
}

export interface AssistantTurnTimingParams {
  message: AssistantTimingMessage;
  observedTtftMs?: number | null;
  observedDecodeMs?: number | null;
}

export function parseAssistantTurnMetrics(
  params: AssistantTurnTimingParams,
): ParsedAssistantTurnMetrics | null {
  const { message, observedTtftMs, observedDecodeMs } = params;
  if (message.role && message.role !== "assistant") {
    return null;
  }

  const nativeTtft = nonnegativeNumber(message.ttft);
  const nativeDuration = nonnegativeNumber(message.duration);
  const output = nonnegativeNumber(message.usage?.output);
  const hasNativeTiming = nativeDuration !== null && nativeTtft !== null;
  // Never subtract timestamps measured by different clocks.
  const decodeMs = hasNativeTiming ? nativeDuration - nativeTtft : (observedDecodeMs ?? null);
  const ttft = nativeTtft ?? observedTtftMs ?? null;
  let tokensPerSecond: number | null = null;
  if (decodeMs !== null && decodeMs > 0 && output !== null) {
    const rate = (output * 1000) / decodeMs;
    if (Number.isFinite(rate)) tokensPerSecond = rate;
  }
  return {
    ttftMs: ttft === null ? null : Math.round(ttft),
    tokensPerSecond,
  };
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export class ModelTurnTracker {
  private currentTurn: AgentModelTurnUsage | null = null;
  private retainedCompletedTurn: AgentModelTurnUsage | null = null;
  private inferenceStartTime: number | null = null;
  private firstDeltaTime: number | null = null;
  private observedTtftMs: number | null = null;
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? (() => performance.now());
  }

  currentModelTurn(): AgentModelTurnUsage | null {
    if (this.currentTurn?.status === "running" && this.retainedCompletedTurn !== null) {
      return this.retainedCompletedTurn;
    }
    return this.currentTurn ?? this.retainedCompletedTurn;
  }

  onTurnStart(): AgentModelTurnUsage {
    this.inferenceStartTime = this.now();
    this.firstDeltaTime = null;
    this.observedTtftMs = null;
    this.currentTurn = {
      status: "running",
      ttftMs: null,
      tokensPerSecond: null,
    };
    return this.currentTurn;
  }

  onContentDelta(): AgentModelTurnUsage | null {
    if (!this.currentTurn || this.currentTurn.status !== "running") {
      return null;
    }
    if (this.firstDeltaTime !== null) {
      return null;
    }
    this.firstDeltaTime = this.now();
    const start = this.inferenceStartTime ?? this.firstDeltaTime;
    this.observedTtftMs = Math.max(0, Math.round(this.firstDeltaTime - start));
    this.currentTurn = {
      status: "running",
      ttftMs: this.observedTtftMs,
      tokensPerSecond: null,
    };
    return this.currentTurn;
  }

  onAssistantMessageEnd(message: AssistantTimingMessage): AgentModelTurnUsage | null {
    const endTime = this.now();
    const observedDecodeMs =
      this.firstDeltaTime !== null ? Math.max(0, endTime - this.firstDeltaTime) : null;

    const parsed = parseAssistantTurnMetrics({
      message,
      observedTtftMs: this.observedTtftMs,
      observedDecodeMs,
    });
    if (!parsed) {
      return null;
    }

    this.currentTurn = {
      status: "completed",
      ttftMs: parsed.ttftMs,
      tokensPerSecond: parsed.tokensPerSecond,
    };
    this.retainedCompletedTurn = this.currentTurn;
    this.inferenceStartTime = null;
    this.firstDeltaTime = null;
    this.observedTtftMs = null;
    return this.currentTurn;
  }

  hydrateFromMessages(messages: readonly AssistantTimingMessage[]): AgentModelTurnUsage | null {
    if (this.currentTurn !== null) {
      return this.currentTurn;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message && message.role === "assistant") {
        const parsed = parseAssistantTurnMetrics({
          message,
          observedTtftMs: null,
          observedDecodeMs: null,
        });
        if (parsed && (parsed.ttftMs !== null || parsed.tokensPerSecond !== null)) {
          this.currentTurn = {
            status: "completed",
            ttftMs: parsed.ttftMs,
            tokensPerSecond: parsed.tokensPerSecond,
          };
          this.retainedCompletedTurn = this.currentTurn;
          return this.currentTurn;
        }
        return null;
      }
    }
    return null;
  }

  finalizeRunning(): boolean {
    if (this.currentTurn?.status === "running") {
      this.currentTurn = {
        status: "completed",
        ttftMs: this.observedTtftMs,
        tokensPerSecond: null,
      };
      this.retainedCompletedTurn = this.currentTurn;
      this.inferenceStartTime = null;
      this.firstDeltaTime = null;
      this.observedTtftMs = null;
      return true;
    }
    return false;
  }
}
