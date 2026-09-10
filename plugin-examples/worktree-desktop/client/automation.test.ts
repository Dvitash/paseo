import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startDesktopAutomation } from "./automation";
import type { DesktopEventsCursor } from "../shared/rpc";

describe("desktop automation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("establishes baseline with null cursor and suppresses opening existing workspaces", async () => {
    const openedWorkspaces: string[] = [];
    const cursorsSent: Array<DesktopEventsCursor | null> = [];

    const handle = startDesktopAutomation({
      pollIntervalMs: 100,
      async fetchEvents(input) {
        cursorsSent.push(input.cursor);
        return {
          cursor: { generation: "gen-1", sequence: 5 },
          workspaceIds: ["existing-1", "existing-2"],
        };
      },
      openPanel(workspaceId) {
        openedWorkspaces.push(workspaceId);
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    handle.stop();

    expect(cursorsSent).toEqual([null]);
    expect(openedWorkspaces).toEqual([]);
    expect(handle.isRunning).toBe(false);
  });

  it("opens panels for fresh workspace events and advances cursor", async () => {
    const openedWorkspaces: string[] = [];
    let pollCount = 0;

    const handle = startDesktopAutomation({
      pollIntervalMs: 100,
      async fetchEvents(input) {
        pollCount += 1;
        if (input.cursor === null) {
          return {
            cursor: { generation: "gen-1", sequence: 0 },
            workspaceIds: [],
          };
        }
        return {
          cursor: { generation: "gen-1", sequence: 1 },
          workspaceIds: ["workspace-alpha"],
        };
      },
      openPanel(workspaceId) {
        openedWorkspaces.push(workspaceId);
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(openedWorkspaces).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    handle.stop();

    expect(pollCount).toBe(2);
    expect(openedWorkspaces).toEqual(["workspace-alpha"]);
  });

  it("handles generation reset by establishing new baseline without opening stale workspaces", async () => {
    const openedWorkspaces: string[] = [];
    let pollStep = 0;

    const handle = startDesktopAutomation({
      pollIntervalMs: 100,
      async fetchEvents() {
        pollStep += 1;
        if (pollStep === 1) {
          return {
            cursor: { generation: "gen-1", sequence: 0 },
            workspaceIds: [],
          };
        }
        if (pollStep === 2) {
          // Backend restarted: new generation with historical IDs
          return {
            cursor: { generation: "gen-2", sequence: 10 },
            workspaceIds: ["historical-ws"],
          };
        }
        return {
          cursor: { generation: "gen-2", sequence: 11 },
          workspaceIds: ["fresh-ws"],
        };
      },
      openPanel(workspaceId) {
        openedWorkspaces.push(workspaceId);
      },
    });

    await vi.advanceTimersByTimeAsync(0); // Poll 1 (baseline gen-1)
    await vi.advanceTimersByTimeAsync(100); // Poll 2 (gen reset gen-2, suppressed)
    expect(openedWorkspaces).toEqual([]);

    await vi.advanceTimersByTimeAsync(100); // Poll 3 (fresh event gen-2)
    handle.stop();

    expect(openedWorkspaces).toEqual(["fresh-ws"]);
  });

  it("deduplicates workspace IDs and retries temporarily failed openPanel without losing intent", async () => {
    const openedWorkspaces: string[] = [];
    let pollStep = 0;
    let failFirstOpen = true;

    const handle = startDesktopAutomation({
      pollIntervalMs: 100,
      async fetchEvents(input) {
        pollStep += 1;
        if (input.cursor === null) {
          return {
            cursor: { generation: "gen-1", sequence: 0 },
            workspaceIds: [],
          };
        }
        if (pollStep === 2) {
          return {
            cursor: { generation: "gen-1", sequence: 1 },
            workspaceIds: ["ws-flaky", "ws-flaky"],
          };
        }
        return {
          cursor: { generation: "gen-1", sequence: 2 },
          workspaceIds: ["ws-flaky", "ws-stable"],
        };
      },
      openPanel(workspaceId) {
        if (workspaceId === "ws-flaky" && failFirstOpen) {
          failFirstOpen = false;
          throw new Error("Context temporarily unavailable");
        }
        openedWorkspaces.push(workspaceId);
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    // Poll 2: ws-flaky fails on first attempt
    await vi.advanceTimersByTimeAsync(100);
    expect(openedWorkspaces).toEqual([]);

    // Poll 3: ws-flaky retried and succeeds, ws-stable opened, duplicates avoided
    await vi.advanceTimersByTimeAsync(100);
    handle.stop();

    expect(openedWorkspaces).toEqual(["ws-flaky", "ws-stable"]);
  });

  it("preserves cursor on transient poll error", async () => {
    const cursorsSent: Array<DesktopEventsCursor | null> = [];
    let pollStep = 0;

    const handle = startDesktopAutomation({
      pollIntervalMs: 100,
      async fetchEvents(input) {
        cursorsSent.push(input.cursor);
        pollStep += 1;
        if (pollStep === 1) {
          return {
            cursor: { generation: "gen-1", sequence: 10 },
            workspaceIds: [],
          };
        }
        if (pollStep === 2) {
          throw new Error("Transient network error");
        }
        return {
          cursor: { generation: "gen-1", sequence: 11 },
          workspaceIds: ["ws-recovered"],
        };
      },
      openPanel() {},
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(100);
    handle.stop();

    expect(cursorsSent[0]).toBeNull();
    expect(cursorsSent[1]).toEqual({ generation: "gen-1", sequence: 10 });
    expect(cursorsSent[2]).toEqual({ generation: "gen-1", sequence: 10 });
  });

  it("stops cleanly and cancels pending timer and in-flight reactions", async () => {
    const openedWorkspaces: string[] = [];
    let resolvePromise:
      | ((value: { cursor: DesktopEventsCursor; workspaceIds: readonly string[] }) => void)
      | undefined;

    const inFlightPromise = new Promise<{
      cursor: DesktopEventsCursor;
      workspaceIds: readonly string[];
    }>((resolve) => {
      resolvePromise = resolve;
    });

    const handle = startDesktopAutomation({
      pollIntervalMs: 100,
      fetchEvents() {
        return inFlightPromise;
      },
      openPanel(workspaceId) {
        openedWorkspaces.push(workspaceId);
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    handle.stop();
    expect(handle.isRunning).toBe(false);

    resolvePromise?.({
      cursor: { generation: "gen-1", sequence: 99 },
      workspaceIds: ["ws-dropped"],
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(openedWorkspaces).toEqual([]);
  });
});
