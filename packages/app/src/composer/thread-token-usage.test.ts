import { describe, expect, it } from "vitest";
import {
  createThreadTokenUsageAccumulator,
  getThreadTokenUsage,
  updateThreadTokenUsage,
} from "./thread-token-usage";

describe("thread token usage accumulator", () => {
  it("keeps the active turn live and accumulates completed turns", () => {
    let state = createThreadTokenUsageAccumulator();

    state = updateThreadTokenUsage(state, 100, {
      inputTokens: 100,
      cachedInputTokens: 70,
      outputTokens: 10,
      modelTurn: { status: "running", ttftMs: 100, tokensPerSecond: 20 },
    });
    expect(getThreadTokenUsage(state)).toEqual({
      inputTokens: 100,
      cachedInputTokens: 70,
      outputTokens: 10,
    });

    state = updateThreadTokenUsage(state, 100, {
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 25,
      modelTurn: { status: "completed", ttftMs: 100, tokensPerSecond: 20 },
    });
    expect(getThreadTokenUsage(state)).toEqual({
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 25,
    });

    state = updateThreadTokenUsage(state, 200, {
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 25,
      modelTurn: { status: "completed", ttftMs: 100, tokensPerSecond: 20 },
    });
    // The previous completed snapshot can remain in the store briefly after the
    // next user message. It must not be counted as the new turn too.
    expect(getThreadTokenUsage(state)).toEqual({
      inputTokens: 120,
      cachedInputTokens: 80,
      outputTokens: 25,
    });

    state = updateThreadTokenUsage(state, 200, {
      modelTurn: { status: "running", ttftMs: null, tokensPerSecond: null },
    });
    state = updateThreadTokenUsage(state, 200, {
      inputTokens: 90,
      cachedInputTokens: 60,
      outputTokens: 15,
      modelTurn: { status: "running", ttftMs: 80, tokensPerSecond: 30 },
    });
    expect(getThreadTokenUsage(state)).toEqual({
      inputTokens: 210,
      cachedInputTokens: 140,
      outputTokens: 40,
    });
  });

  it("preserves token fields omitted by intermediate live updates", () => {
    let state = createThreadTokenUsageAccumulator();
    state = updateThreadTokenUsage(state, 100, {
      inputTokens: 50,
      cachedInputTokens: 40,
      outputTokens: 5,
      modelTurn: { status: "running", ttftMs: 100, tokensPerSecond: 10 },
    });
    state = updateThreadTokenUsage(state, 100, {
      modelTurn: { status: "running", ttftMs: 100, tokensPerSecond: 12 },
    });

    expect(getThreadTokenUsage(state)).toEqual({
      inputTokens: 50,
      cachedInputTokens: 40,
      outputTokens: 5,
    });
  });

  it("resets accumulated usage when the conversation rewinds", () => {
    let state = createThreadTokenUsageAccumulator();
    state = updateThreadTokenUsage(state, 200, {
      inputTokens: 100,
      outputTokens: 20,
      modelTurn: { status: "completed", ttftMs: 100, tokensPerSecond: 10 },
    });
    state = updateThreadTokenUsage(state, 100, {
      inputTokens: 40,
      cachedInputTokens: 30,
      outputTokens: 8,
      modelTurn: { status: "completed", ttftMs: 100, tokensPerSecond: 10 },
    });

    expect(getThreadTokenUsage(state)).toEqual({
      inputTokens: 40,
      cachedInputTokens: 30,
      outputTokens: 8,
    });
  });
});
