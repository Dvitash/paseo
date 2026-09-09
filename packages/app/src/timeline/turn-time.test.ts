import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { deriveStreamTurnTiming } from "./turn-time";
import type { StreamItem } from "@/types/stream";

function user(id: string, timestamp: Date): StreamItem {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp,
  };
}

function assistant(id: string, timestamp: Date): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp,
  };
}

describe("deriveStreamTurnTiming", () => {
  it("starts elapsed time from the submitted prompt", () => {
    const submittedAt = new Date("2026-05-15T00:00:00.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: submittedAt,
      tail: [],
      head: [user("submitted", submittedAt)],
    });

    assert.equal(timing.runningStartedAt, submittedAt);
  });

  it("uses the last user message as the running turn start", () => {
    const firstUserAt = new Date("2026-05-15T00:00:00.000Z");
    const secondUserAt = new Date("2026-05-15T00:01:00.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: secondUserAt,
      tail: [
        user("u1", firstUserAt),
        assistant("a1", new Date("2026-05-15T00:00:05.000Z")),
        user("u2", secondUserAt),
      ],
      head: [assistant("a2", new Date("2026-05-15T00:01:04.000Z"))],
    });

    assert.equal(timing.runningStartedAt, secondUserAt);
    assert.equal(timing.byAssistantId.has("a2"), false);
  });

  it("derives completed turn timing from user and assistant item timestamps", () => {
    const userAt = new Date("2026-05-15T00:00:00.000Z");
    const assistantAt = new Date("2026-05-15T00:00:07.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        user("u1", userAt),
        assistant("a1", assistantAt),
        user("u2", new Date("2026-05-15T00:01:00.000Z")),
      ],
      head: [],
    });

    assert.deepEqual(timing.byAssistantId.get("a1"), {
      completedAt: assistantAt,
      durationMs: 7000,
    });
  });

  it("maps multiple assistant chunks in one turn to the same timing", () => {
    const userAt = new Date("2026-05-15T00:00:00.000Z");
    const firstAssistantAt = new Date("2026-05-15T00:00:03.000Z");
    const lastAssistantAt = new Date("2026-05-15T00:00:07.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        user("u1", userAt),
        assistant("a1", firstAssistantAt),
        assistant("a2", lastAssistantAt),
      ],
      head: [],
    });

    const expected = {
      completedAt: lastAssistantAt,
      durationMs: 7000,
    };
    assert.deepEqual(timing.byAssistantId.get("a1"), expected);
    assert.deepEqual(timing.byAssistantId.get("a2"), expected);
  });

  it("preserves the completion timestamp when a canonical turn has no visible prompt", () => {
    const firstTurnAt = new Date("2026-05-15T00:00:00.000Z");
    const hiddenPromptTurnAt = new Date("2026-05-15T00:01:07.000Z");
    const timing = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail: [
        { ...user("u1", firstTurnAt), turnId: "turn-1" },
        {
          ...assistant("a1", new Date("2026-05-15T00:00:07.000Z")),
          turnId: "turn-1",
        },
        {
          ...assistant("hidden-prompt-a1", new Date("2026-05-15T00:01:03.000Z")),
          turnId: "turn-2",
        },
        { ...assistant("hidden-prompt-a2", hiddenPromptTurnAt), turnId: "turn-2" },
      ],
      head: [],
    });

    assert.deepEqual(timing.byAssistantId.get("hidden-prompt-a2"), {
      completedAt: hiddenPromptTurnAt,
      durationMs: null,
    });
  });

  it("does not repeat full-tail scan for unchanged tail and rescans on tail replacement", () => {
    let u1TimestampAccesses = 0;
    const trackedItem: StreamItem = {
      kind: "user_message",
      id: "u1",
      text: "u1",
      get timestamp() {
        u1TimestampAccesses++;
        return new Date("2026-05-15T00:00:00.000Z");
      },
    };
    const tail1 = [
      trackedItem,
      assistant("a1", new Date("2026-05-15T00:00:05.000Z")),
      user("u2", new Date("2026-05-15T00:01:00.000Z")),
    ];
    const headChunk1 = [assistant("a2", new Date("2026-05-15T00:01:02.000Z"))];
    const headChunk2 = [assistant("a2", new Date("2026-05-15T00:01:04.000Z"))];

    const timing1 = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: tail1[2]!.timestamp,
      tail: tail1,
      head: headChunk1,
    });
    assert.ok(u1TimestampAccesses > 0);
    const accessCountAfterFirst = u1TimestampAccesses;
    const timing2 = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: tail1[2]!.timestamp,
      tail: tail1,
      head: headChunk2,
    });
    assert.equal(u1TimestampAccesses, accessCountAfterFirst);
    assert.equal(timing1.byAssistantId, timing2.byAssistantId);
    let replacedItemAccesses = 0;
    const trackedReplacedItem: StreamItem = {
      kind: "user_message",
      id: "u1_new",
      text: "u1_new",
      get timestamp() {
        replacedItemAccesses++;
        return new Date("2026-05-15T00:00:00.000Z");
      },
    };
    const tail2 = [
      trackedReplacedItem,
      assistant("a1", new Date("2026-05-15T00:00:05.000Z")),
      user("u2", new Date("2026-05-15T00:01:00.000Z")),
    ];
    deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: tail2[2]!.timestamp,
      tail: tail2,
      head: [assistant("a2", new Date("2026-05-15T00:01:02.000Z"))],
    });
    assert.ok(replacedItemAccesses > 0);
    assert.equal(u1TimestampAccesses, accessCountAfterFirst);
  });

  it("preserves byAssistantId identity when tail ends completed turn and head begins new user turn with streaming text growth", () => {
    const tail = [
      user("u1", new Date("2026-05-15T00:00:00.000Z")),
      assistant("a1", new Date("2026-05-15T00:00:05.000Z")),
    ];
    const userPromptAt = new Date("2026-05-15T00:01:00.000Z");
    const headChunk1 = [
      user("u2", userPromptAt),
      assistant("a2", new Date("2026-05-15T00:01:02.000Z")),
    ];
    const headChunk2 = [
      user("u2", userPromptAt),
      {
        ...assistant("a2", new Date("2026-05-15T00:01:02.000Z")),
        text: "a2 streaming text growth",
      },
    ];

    const first = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: userPromptAt,
      tail,
      head: headChunk1,
    });
    const second = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: userPromptAt,
      tail,
      head: headChunk2,
    });

    assert.equal(first.byAssistantId, second.byAssistantId);
    assert.deepEqual(second.byAssistantId.get("a1"), {
      completedAt: new Date("2026-05-15T00:00:05.000Z"),
      durationMs: 5000,
    });
    assert.equal(second.byAssistantId.has("a2"), false);
  });

  it("reuses unchanged history timing structure on text-only head growth", () => {
    const tail = [
      user("u1", new Date("2026-05-15T00:00:00.000Z")),
      assistant("a1", new Date("2026-05-15T00:00:03.000Z")),
      user("u2", new Date("2026-05-15T00:01:00.000Z")),
    ];
    const chunk1 = [assistant("a2", new Date("2026-05-15T00:01:02.000Z"))];
    const chunk2 = [assistant("a2", new Date("2026-05-15T00:01:02.000Z"))];

    const first = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: tail[2]!.timestamp,
      tail,
      head: chunk1,
    });
    const second = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: tail[2]!.timestamp,
      tail,
      head: chunk2,
    });

    assert.equal(first.byAssistantId, second.byAssistantId);
    assert.deepEqual(second.byAssistantId.get("a1"), {
      completedAt: new Date("2026-05-15T00:00:03.000Z"),
      durationMs: 3000,
    });
    assert.equal(second.byAssistantId.has("a2"), false);
  });

  it("correctly resolves turn boundaries and avoids stale timestamps across tail and head", () => {
    const u1At = new Date("2026-05-15T00:00:00.000Z");
    const a1TailAt = new Date("2026-05-15T00:00:04.000Z");
    const a1HeadAt = new Date("2026-05-15T00:00:09.000Z");

    const tail = [user("u1", u1At), assistant("a1_tail", a1TailAt)];
    const head = [assistant("a1_head", a1HeadAt)];

    const active = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: u1At,
      tail,
      head,
    });
    assert.equal(active.byAssistantId.has("a1_tail"), false);
    assert.equal(active.byAssistantId.has("a1_head"), false);
    assert.equal(active.runningStartedAt, u1At);

    const completed = deriveStreamTurnTiming({
      isTurnActive: false,
      activeTurnStartedAt: null,
      tail,
      head,
    });
    assert.equal(completed.runningStartedAt, null);
    const expectedTiming = {
      completedAt: a1HeadAt,
      durationMs: 9000,
    };
    assert.deepEqual(completed.byAssistantId.get("a1_tail"), expectedTiming);
    assert.deepEqual(completed.byAssistantId.get("a1_head"), expectedTiming);
  });

  it("handles turn boundaries within head and completes earlier turn while keeping later turn active", () => {
    const u1At = new Date("2026-05-15T00:00:00.000Z");
    const a1At = new Date("2026-05-15T00:00:04.000Z");
    const u2At = new Date("2026-05-15T00:01:00.000Z");
    const a2At = new Date("2026-05-15T00:01:05.000Z");

    const timing = deriveStreamTurnTiming({
      isTurnActive: true,
      activeTurnStartedAt: u2At,
      tail: [user("u1", u1At)],
      head: [assistant("a1", a1At), user("u2", u2At), assistant("a2", a2At)],
    });

    assert.equal(timing.runningStartedAt, u2At);
    assert.deepEqual(timing.byAssistantId.get("a1"), {
      completedAt: a1At,
      durationMs: 4000,
    });
    assert.equal(timing.byAssistantId.has("a2"), false);
  });
});
