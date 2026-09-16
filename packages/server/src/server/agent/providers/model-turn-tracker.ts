import type { AgentModelTurnUsage } from "../agent-sdk-types.js";

const LIVE_TPS_UPDATE_INTERVAL_MS = 250;
const MIN_LIVE_OUTPUT_DELTAS = 4;

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
  const observedTtft = nonnegativeNumber(observedTtftMs);
  const observedDecode = nonnegativeNumber(observedDecodeMs);
  const output = nonnegativeNumber(message.usage?.output);
  const hasNativeTiming = nativeDuration !== null && nativeTtft !== null;
  // Never subtract timestamps measured by different clocks.
  const decodeMs = hasNativeTiming ? nativeDuration - nativeTtft : observedDecode;
  const ttft = nativeTtft ?? observedTtft;
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
  private observedOutputDeltas = 0;
  private lastLivePublishTime: number | null = null;
  private liveTurnVisible = false;
  private readonly now: () => number;

  constructor(options?: { now?: () => number }) {
    this.now = options?.now ?? (() => performance.now());
  }

  currentModelTurn(): AgentModelTurnUsage | null {
    // Keep the last completed result visible while the next inference is only
    // waiting on the model. Once the new stream has a stable live TPS sample,
    // switch the pill to the current turn.
    if (
      this.currentTurn?.status === "running" &&
      !this.liveTurnVisible &&
      this.retainedCompletedTurn !== null
    ) {
      return this.retainedCompletedTurn;
    }
    return this.currentTurn ?? this.retainedCompletedTurn;
  }

  onTurnStart(): AgentModelTurnUsage {
    this.inferenceStartTime = this.now();
    this.firstDeltaTime = null;
    this.observedTtftMs = null;
    this.observedOutputDeltas = 0;
    this.lastLivePublishTime = null;
    this.liveTurnVisible = false;
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

    const now = this.now();
    const firstDelta = this.firstDeltaTime === null;
    if (firstDelta) {
      this.firstDeltaTime = now;
      const start = this.inferenceStartTime ?? this.firstDeltaTime;
      this.observedTtftMs = Math.max(0, Math.round(this.firstDeltaTime - start));
    }

    // Pi/OMP surface model output as streaming text/thinking/tool-call deltas.
    // During the stream, use the cumulative delta rate as the best live TPS
    // estimate available without waiting for final provider usage. The final
    // provider-reported output token count replaces this estimate on message_end.
    this.observedOutputDeltas += 1;
    const firstDeltaTime = this.firstDeltaTime ?? now;
    const decodeMs = Math.max(0, now - firstDeltaTime);
    const liveTokensPerSecond = decodeMs > 0 ? (this.observedOutputDeltas * 1000) / decodeMs : null;

    this.currentTurn = {
      status: "running",
      ttftMs: this.observedTtftMs,
      tokensPerSecond:
        liveTokensPerSecond !== null && Number.isFinite(liveTokensPerSecond)
          ? liveTokensPerSecond
          : null,
    };

    if (firstDelta) {
      this.lastLivePublishTime = now;
      // Preserve the previous completed pill until the new stream has enough
      // output to display a meaningful live rate. With no previous result,
      // surface TTFT immediately.
      if (this.retainedCompletedTurn === null) {
        this.liveTurnVisible = true;
      }
      return this.currentTurn;
    }

    if (this.observedOutputDeltas < MIN_LIVE_OUTPUT_DELTAS) {
      return null;
    }

    const lastPublish = this.lastLivePublishTime ?? firstDeltaTime;
    if (now - lastPublish < LIVE_TPS_UPDATE_INTERVAL_MS) {
      return null;
    }

    this.lastLivePublishTime = now;
    this.liveTurnVisible = true;
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
      // Prefer exact provider usage. If unavailable, retain the live stream
      // estimate rather than dropping a useful TPS value at completion.
      tokensPerSecond: parsed.tokensPerSecond ?? this.currentTurn?.tokensPerSecond ?? null,
    };
    this.retainedCompletedTurn = this.currentTurn;
    this.resetObservationState();
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
        tokensPerSecond: this.currentTurn.tokensPerSecond,
      };
      this.retainedCompletedTurn = this.currentTurn;
      this.resetObservationState();
      return true;
    }
    return false;
  }

  private resetObservationState(): void {
    this.inferenceStartTime = null;
    this.firstDeltaTime = null;
    this.observedTtftMs = null;
    this.observedOutputDeltas = 0;
    this.lastLivePublishTime = null;
    this.liveTurnVisible = false;
  }
}
