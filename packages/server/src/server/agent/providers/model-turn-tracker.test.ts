import { describe, expect, it } from "vitest";
import { ModelTurnTracker } from "./model-turn-tracker.js";

describe("ModelTurnTracker", () => {
  it("initializes on turn_start with running status and null metrics", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    expect(tracker.currentModelTurn()).toBeNull();

    const turn = tracker.onTurnStart();
    expect(turn).toEqual({
      status: "running",
      ttftMs: null,
      tokensPerSecond: null,
    });
    expect(tracker.currentModelTurn()).toEqual(turn);
  });

  it("records observed TTFT on first content delta and ignores subsequent deltas", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    tracker.onTurnStart();

    // 150.4ms later, first text delta arrives
    clock = 1150.4;
    const firstDelta = tracker.onContentDelta();
    expect(firstDelta).toEqual({
      status: "running",
      ttftMs: 150,
      tokensPerSecond: null,
    });
    expect(tracker.currentModelTurn()?.ttftMs).toBe(150);

    // Subsequent deltas must return null and not modify ttftMs
    clock = 1200;
    const secondDelta = tracker.onContentDelta();
    expect(secondDelta).toBeNull();
    expect(tracker.currentModelTurn()?.ttftMs).toBe(150);

    clock = 1500;
    const thirdDelta = tracker.onContentDelta();
    expect(thirdDelta).toBeNull();
    expect(tracker.currentModelTurn()?.ttftMs).toBe(150);
  });

  it("prefers native exact completion timings when both duration and ttft are present", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    tracker.onTurnStart();
    clock = 1120;
    tracker.onContentDelta();

    // Native exact ttft = 100.25ms, duration = 600.25ms, output = 25 tokens
    // Denominator = (600.25 - 100.25) / 1000 = 0.5 (exact unrounded float)
    // TPS = 25 / 0.5 = 50
    clock = 1600;
    const completed = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 100.25,
      duration: 600.25,
      usage: { output: 25 },
    });

    expect(completed).toEqual({
      status: "completed",
      ttftMs: 100, // rounded for integer display field
      tokensPerSecond: 50,
    });
    expect(tracker.currentModelTurn()).toEqual(completed);
  });

  it("computes live TPS using observed decode interval when native duration/ttft are absent (Pi)", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    tracker.onTurnStart();

    // First content delta at 1250ms (TTFT = 250ms)
    clock = 1250;
    tracker.onContentDelta();
    expect(tracker.currentModelTurn()?.ttftMs).toBe(250);

    // Completion at 2250ms (Observed decode interval = 2250 - 1250 = 1000ms = 1.0s)
    // Message has actual usage.output = 45 tokens, but no native duration/ttft
    clock = 2250;
    const completed = tracker.onAssistantMessageEnd({
      role: "assistant",
      usage: { output: 45 },
    });

    // TPS = 45 / (1000 / 1000) = 45
    expect(completed).toEqual({
      status: "completed",
      ttftMs: 250,
      tokensPerSecond: 45,
    });
  });

  it("never mixes native duration with observed TTFT clock", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    tracker.onTurnStart();
    clock = 1100; // observed TTFT = 100ms
    tracker.onContentDelta();

    // Message provides native duration = 800ms, but NO native ttft.
    // Must NOT compute (800 - 100). Instead, uses observed decode interval (1600 - 1100 = 500ms).
    clock = 1600;
    const completed = tracker.onAssistantMessageEnd({
      role: "assistant",
      duration: 800,
      usage: { output: 30 },
    });

    // TPS = 30 / (500 / 1000) = 60 (NOT 30 / (700/1000) = 42.85)
    expect(completed).toEqual({
      status: "completed",
      ttftMs: 100,
      tokensPerSecond: 60,
    });
  });

  it("sets tokensPerSecond to null when duration is invalid or <= ttft", () => {
    const tracker = new ModelTurnTracker();

    // duration <= ttft
    tracker.onTurnStart();
    const completedZeroDenom = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 300,
      duration: 300,
      usage: { output: 50 },
    });
    expect(completedZeroDenom).toEqual({
      status: "completed",
      ttftMs: 300,
      tokensPerSecond: null,
    });

    // duration < ttft
    tracker.onTurnStart();
    const completedNegDenom = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 500,
      duration: 200,
      usage: { output: 50 },
    });
    expect(completedNegDenom).toEqual({
      status: "completed",
      ttftMs: 500,
      tokensPerSecond: null,
    });

    // negative duration
    tracker.onTurnStart();
    const completedNegDuration = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 100,
      duration: -500,
      usage: { output: 50 },
    });
    expect(completedNegDuration).toEqual({
      status: "completed",
      ttftMs: 100,
      tokensPerSecond: null,
    });
  });

  it("keeps explicit unknown metrics as null when values are unavailable", () => {
    const tracker = new ModelTurnTracker();

    // output tokens unavailable
    tracker.onTurnStart();
    const noOutput = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 150,
      duration: 1000,
    });
    expect(noOutput).toEqual({
      status: "completed",
      ttftMs: 150,
      tokensPerSecond: null,
    });

    // duration unavailable and no live deltas observed
    tracker.onTurnStart();
    const noDuration = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 150,
      usage: { output: 30 },
    });
    expect(noDuration).toEqual({
      status: "completed",
      ttftMs: 150,
      tokensPerSecond: null,
    });

    // neither ttft nor duration nor output available
    tracker.onTurnStart();
    const noMetrics = tracker.onAssistantMessageEnd({
      role: "assistant",
    });
    expect(noMetrics).toEqual({
      status: "completed",
      ttftMs: null,
      tokensPerSecond: null,
    });
  });

  it("handles multiple inference turns with per-inference reset and retains completed during idle", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    // Inference 1
    tracker.onTurnStart();
    clock = 1100;
    tracker.onContentDelta();
    clock = 1400;
    const turn1Completed = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 100,
      duration: 400,
      usage: { output: 15 },
    });
    expect(turn1Completed).toEqual({
      status: "completed",
      ttftMs: 100,
      tokensPerSecond: 50,
    });

    // During tool execution / idle time, completed turn is retained
    clock = 5000;
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);

    // Inference 2 begins
    clock = 6000;
    const turn2Running = tracker.onTurnStart();
    expect(turn2Running).toEqual({
      status: "running",
      ttftMs: null,
      tokensPerSecond: null,
    });
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);

    // Inference 2 completes
    clock = 6200;
    tracker.onContentDelta();
    clock = 6800;
    const turn2Completed = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 200,
      duration: 800,
      usage: { output: 48 },
    });
    expect(turn2Completed).toEqual({
      status: "completed",
      ttftMs: 200,
      tokensPerSecond: 80,
    });
    expect(tracker.currentModelTurn()).toEqual(turn2Completed);
  });

  it("finalizes running turn on error/cancel, retaining observed TTFT with null TPS", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    tracker.onTurnStart();
    clock = 1180;
    tracker.onContentDelta();
    expect(tracker.currentModelTurn()?.status).toBe("running");

    // Interrupted: finalizeRunning converts running to completed with observed TTFT and null TPS
    expect(tracker.finalizeRunning()).toBe(true);
    expect(tracker.currentModelTurn()).toEqual({
      status: "completed",
      ttftMs: 180,
      tokensPerSecond: null,
    });

    // Calling finalizeRunning when already completed returns false
    expect(tracker.finalizeRunning()).toBe(false);
  });

  it("shows completed metrics on assistant message error if native timings are present", () => {
    const tracker = new ModelTurnTracker();

    tracker.onTurnStart();
    const erroredWithMetrics = tracker.onAssistantMessageEnd({
      role: "assistant",
      errorMessage: "Context window exceeded after generation",
      stopReason: "error",
      ttft: 120,
      duration: 620,
      usage: { output: 25 },
    });

    expect(erroredWithMetrics).toEqual({
      status: "completed",
      ttftMs: 120,
      tokensPerSecond: 50,
    });
  });

  it("hydrates latest completed assistant metrics from history and cannot infer elapsed when native absent", () => {
    const tracker = new ModelTurnTracker();

    // History message with native duration and ttft
    const historyWithNative = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        ttft: 120,
        duration: 620,
        usage: { output: 25 },
      },
    ];

    const hydratedNative = tracker.hydrateFromMessages(historyWithNative);
    expect(hydratedNative).toEqual({
      status: "completed",
      ttftMs: 120,
      tokensPerSecond: 50,
    });

    // History message without native duration/ttft => cannot infer elapsed => TPS is null
    const tracker2 = new ModelTurnTracker();
    const historyWithoutNative = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        usage: { output: 40 },
      },
    ];
    const hydratedNoNative = tracker2.hydrateFromMessages(historyWithoutNative);
    expect(hydratedNoNative).toBeNull();
  });

  it("retains previous completed metrics when next turn starts and during subsequent deltas", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    // Turn 1
    tracker.onTurnStart();
    clock = 1150;
    tracker.onContentDelta();
    clock = 1650;
    const turn1Completed = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 150,
      duration: 650,
      usage: { output: 30 },
    });
    expect(turn1Completed).toEqual({
      status: "completed",
      ttftMs: 150,
      tokensPerSecond: 60,
    });
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);

    // Turn 2 starts - onTurnStart returns running with nulls, currentModelTurn retains turn 1
    clock = 2000;
    const turn2Running = tracker.onTurnStart();
    expect(turn2Running).toEqual({
      status: "running",
      ttftMs: null,
      tokensPerSecond: null,
    });
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);

    // Turn 2 first delta - onContentDelta returns running with new observed TTFT, currentModelTurn still retains turn 1
    clock = 2220;
    const turn2Delta = tracker.onContentDelta();
    expect(turn2Delta).toEqual({
      status: "running",
      ttftMs: 220,
      tokensPerSecond: null,
    });
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);

    // Turn 2 subsequent deltas return null and currentModelTurn remains turn 1
    clock = 2300;
    expect(tracker.onContentDelta()).toBeNull();
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);
  });

  it("replaces retained completed turn upon next turn completion even if new metrics are unavailable", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    // Turn 1 completes with valid metrics
    tracker.onTurnStart();
    const turn1Completed = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 100,
      duration: 500,
      usage: { output: 20 },
    });
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);

    // Turn 2 starts and completes without native timing or deltas
    clock = 2000;
    tracker.onTurnStart();
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);

    const turn2Completed = tracker.onAssistantMessageEnd({
      role: "assistant",
    });
    expect(turn2Completed).toEqual({
      status: "completed",
      ttftMs: null,
      tokensPerSecond: null,
    });
    // Replaced with turn 2's completed turn, true unavailable values preserved
    expect(tracker.currentModelTurn()).toEqual({
      status: "completed",
      ttftMs: null,
      tokensPerSecond: null,
    });

    // Turn 3 starts while turn 2 completed is retained
    clock = 3000;
    tracker.onTurnStart();
    expect(tracker.currentModelTurn()).toEqual({
      status: "completed",
      ttftMs: null,
      tokensPerSecond: null,
    });

    // Turn 3 completes with fresh metrics
    const turn3Completed = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 200,
      duration: 600,
      usage: { output: 20 },
    });
    expect(turn3Completed).toEqual({
      status: "completed",
      ttftMs: 200,
      tokensPerSecond: 50,
    });
    expect(tracker.currentModelTurn()).toEqual(turn3Completed);
  });

  it("retains hydrated metrics when a running turn starts and processes deltas", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    const historyWithNative = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        ttft: 120,
        duration: 520,
        usage: { output: 20 },
      },
    ];
    const hydrated = tracker.hydrateFromMessages(historyWithNative);
    expect(hydrated).toEqual({
      status: "completed",
      ttftMs: 120,
      tokensPerSecond: 50,
    });
    expect(tracker.currentModelTurn()).toEqual(hydrated);

    // New running turn begins
    const running = tracker.onTurnStart();
    expect(running).toEqual({
      status: "running",
      ttftMs: null,
      tokensPerSecond: null,
    });
    // Retains hydrated metrics while running
    expect(tracker.currentModelTurn()).toEqual(hydrated);

    // Delta arrives during the running turn
    clock = 1180;
    const delta = tracker.onContentDelta();
    expect(delta).toEqual({
      status: "running",
      ttftMs: 180,
      tokensPerSecond: null,
    });
    expect(tracker.currentModelTurn()).toEqual(hydrated);

    // Turn completes, updating currentModelTurn to new turn metrics
    clock = 1580;
    const completed = tracker.onAssistantMessageEnd({
      role: "assistant",
      usage: { output: 24 },
    });
    expect(completed).toEqual({
      status: "completed",
      ttftMs: 180,
      tokensPerSecond: 60,
    });
    expect(tracker.currentModelTurn()).toEqual(completed);
  });

  it("updates retained state on finalizeRunning interruption and carries into next running turn", () => {
    let clock = 1000;
    const tracker = new ModelTurnTracker({ now: () => clock });

    // Turn 1 completes normally
    tracker.onTurnStart();
    const turn1Completed = tracker.onAssistantMessageEnd({
      role: "assistant",
      ttft: 100,
      duration: 500,
      usage: { output: 20 },
    });
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);

    // Turn 2 begins and receives a delta
    clock = 2000;
    tracker.onTurnStart();
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);

    clock = 2160;
    tracker.onContentDelta();
    expect(tracker.currentModelTurn()).toEqual(turn1Completed);

    // Turn 2 is interrupted / cancelled
    expect(tracker.finalizeRunning()).toBe(true);
    expect(tracker.currentModelTurn()).toEqual({
      status: "completed",
      ttftMs: 160,
      tokensPerSecond: null,
    });

    // Turn 3 begins - retains Turn 2's finalized metrics
    clock = 3000;
    tracker.onTurnStart();
    expect(tracker.currentModelTurn()).toEqual({
      status: "completed",
      ttftMs: 160,
      tokensPerSecond: null,
    });

    // Turn 3 is cancelled immediately without any delta
    expect(tracker.finalizeRunning()).toBe(true);
    expect(tracker.currentModelTurn()).toEqual({
      status: "completed",
      ttftMs: null,
      tokensPerSecond: null,
    });

    // Turn 4 begins - retains Turn 3's finalized metrics (nulls, not Turn 2's)
    clock = 4000;
    tracker.onTurnStart();
    expect(tracker.currentModelTurn()).toEqual({
      status: "completed",
      ttftMs: null,
      tokensPerSecond: null,
    });
  });
});
