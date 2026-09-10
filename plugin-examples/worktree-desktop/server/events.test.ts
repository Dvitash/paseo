import { describe, expect, it } from "vitest";
import { DesktopEventQueue } from "./events";

describe("DesktopEventQueue", () => {
  it("establishes baseline on initial null cursor with no workspaceIds", () => {
    const queue = new DesktopEventQueue("gen-1");
    queue.publish("ws-1");
    queue.publish("ws-2");

    const result = queue.poll(null);
    expect(result.cursor.generation).toBe("gen-1");
    expect(result.cursor.sequence).toBe(2);
    expect(result.workspaceIds).toEqual([]);
  });

  it("resets baseline on generation mismatch without replaying older events", () => {
    const queue = new DesktopEventQueue("gen-new");
    queue.publish("ws-1");

    const oldCursor = { generation: "gen-old", sequence: 0 };
    const result = queue.poll(oldCursor);

    expect(result.cursor.generation).toBe("gen-new");
    expect(result.cursor.sequence).toBe(1);
    expect(result.workspaceIds).toEqual([]);
  });

  it("returns newly published events for matching generation", () => {
    const queue = new DesktopEventQueue("gen-1");
    const baseline = queue.poll(null);

    queue.publish("ws-a");
    queue.publish("ws-b");

    const delta = queue.poll(baseline.cursor);
    expect(delta.cursor.generation).toBe("gen-1");
    expect(delta.cursor.sequence).toBe(2);
    expect(delta.workspaceIds).toEqual(["ws-a", "ws-b"]);
  });

  it("returns empty workspaceIds when cursor is already at latest sequence", () => {
    const queue = new DesktopEventQueue("gen-1");
    queue.publish("ws-1");

    const firstPoll = queue.poll({ generation: "gen-1", sequence: 0 });
    expect(firstPoll.workspaceIds).toEqual(["ws-1"]);

    const secondPoll = queue.poll(firstPoll.cursor);
    expect(secondPoll.workspaceIds).toEqual([]);
    expect(secondPoll.cursor.sequence).toBe(1);
  });

  it("bounds queue retention to 128 events", () => {
    const queue = new DesktopEventQueue("gen-1");
    for (let i = 1; i <= 150; i++) {
      queue.publish(`ws-${i}`);
    }

    expect(queue.getLatestSequence()).toBe(150);

    // Polling with sequence 0 should return at most the 128 retained events
    const poll = queue.poll({ generation: "gen-1", sequence: 0 });
    expect(poll.workspaceIds.length).toBe(128);
    expect(poll.workspaceIds[0]).toBe("ws-23");
    expect(poll.workspaceIds[127]).toBe("ws-150");
    expect(poll.cursor.sequence).toBe(150);
  });
});
