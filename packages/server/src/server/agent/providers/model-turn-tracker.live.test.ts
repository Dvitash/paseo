import { describe, expect, it } from "vitest";
import { ModelTurnTracker, parseAssistantTurnMetrics } from "./model-turn-tracker.js";

describe("ModelTurnTracker live streaming metrics", () => {
  it("recalculates cumulative live TPS across the entire stream", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    tracker.onTurnStart();

    clock = 1100;
    expect(tracker.onContentDelta()).toEqual({
      status: "running",
      ttftMs: 100,
      tokensPerSecond: null,
    });

    clock = 1150;
    expect(tracker.onContentDelta()).toBeNull();
    clock = 1200;
    expect(tracker.onContentDelta()).toBeNull();

    // Four streamed output deltas across the full 250 ms decode interval.
    clock = 1350;
    expect(tracker.onContentDelta()).toEqual({
      status: "running",
      ttftMs: 100,
      tokensPerSecond: 16,
    });

    // The next sample still uses the full stream: 5 deltas / 500 ms = 10/s.
    clock = 1600;
    expect(tracker.onContentDelta()).toEqual({
      status: "running",
      ttftMs: 100,
      tokensPerSecond: 10,
    });
  });

  it("switches from retained metrics to live metrics during streamed thinking output", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    tracker.onTurnStart();
    clock = 1100;
    tracker.onContentDelta();
    clock = 1500;
    const previous = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 100,
      duration: 500,
      usage: { output: 20 },
    });
    expect(previous).toEqual({
      status: "completed",
      ttftMs: 100,
      tokensPerSecond: 50,
    });

    clock = 2000;
    tracker.onTurnStart();
    expect(tracker.currentModelTurn()).toEqual(previous);

    // Pi and OMP route thinking_delta through onContentDelta just like text_delta.
    clock = 2200;
    expect(tracker.onContentDelta()).toEqual({
      status: "running",
      ttftMs: 200,
      tokensPerSecond: null,
    });
    expect(tracker.currentModelTurn()).toEqual(previous);

    clock = 2250;
    tracker.onContentDelta();
    clock = 2300;
    tracker.onContentDelta();
    clock = 2450;
    expect(tracker.onContentDelta()).toEqual({
      status: "running",
      ttftMs: 200,
      tokensPerSecond: 16,
    });
    expect(tracker.currentModelTurn()).toEqual({
      status: "running",
      ttftMs: 200,
      tokensPerSecond: 16,
    });
  });

  it("replaces the live estimate with exact provider TPS at completion", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    tracker.onTurnStart();
    clock = 1100;
    tracker.onContentDelta();
    clock = 1150;
    tracker.onContentDelta();
    clock = 1200;
    tracker.onContentDelta();
    clock = 1350;
    expect(tracker.onContentDelta()?.tokensPerSecond).toBe(16);

    clock = 1600;
    expect(
      tracker.onAssistantMessageEnd({
        role: "assistant",
        ttft: 100,
        duration: 600,
        usage: { output: 25 },
      }),
    ).toEqual({
      status: "completed",
      ttftMs: 100,
      tokensPerSecond: 50,
    });
  });

  it("sanitizes invalid observed timing values instead of propagating NaN or Infinity", () => {
    expect(
      parseAssistantTurnMetrics({
        message: { role: "assistant", usage: { output: 20 } },
        observedTtftMs: Number.POSITIVE_INFINITY,
        observedDecodeMs: Number.NaN,
      }),
    ).toEqual({
      ttftMs: null,
      tokensPerSecond: null,
    });
  });
});
