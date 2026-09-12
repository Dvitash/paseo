import type { DesktopEventsCursor } from "../shared/rpc";

export interface AutomationScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export const defaultScheduler: AutomationScheduler = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

export interface AutomationPorts {
  fetchEvents(input: { cursor: DesktopEventsCursor | null }): Promise<{
    cursor: DesktopEventsCursor;
    workspaceIds: readonly string[];
  }>;
  openPanel(workspaceId: string): void | Promise<void>;
  scheduler?: AutomationScheduler;
  pollIntervalMs?: number;
}

export interface AutomationHandle {
  stop(): void;
  readonly isRunning: boolean;
}

export function startDesktopAutomation(ports: AutomationPorts): AutomationHandle {
  let cursor: DesktopEventsCursor | null = null;
  const openedWorkspaces = new Set<string>();
  const pendingWorkspaces = new Set<string>();
  let stopped = false;
  let cancelTimer: (() => void) | null = null;
  let pollInFlight = false;

  const scheduler = ports.scheduler ?? defaultScheduler;
  const intervalMs = ports.pollIntervalMs ?? 1000;

  function scheduleNextPoll(delayMs: number): void {
    if (stopped) return;
    cancelTimer?.();
    cancelTimer = scheduler.schedule(() => {
      cancelTimer = null;
      void runPoll();
    }, delayMs);
  }

  async function runPoll(): Promise<void> {
    if (stopped || pollInFlight) return;
    pollInFlight = true;

    try {
      const result = await ports.fetchEvents({ cursor });
      if (stopped) return;

      if (cursor === null) {
        // Initial baseline establishes cursor without opening existing workspaces
        cursor = result.cursor;
        return;
      }

      if (result.cursor.generation !== cursor.generation) {
        // Generation reset: server restarted or stream reconnected.
        // Establish new baseline to avoid reopening stale historical workspaces.
        cursor = result.cursor;
        pendingWorkspaces.clear();
        return;
      }

      for (const workspaceId of result.workspaceIds) {
        if (workspaceId && !openedWorkspaces.has(workspaceId)) {
          pendingWorkspaces.add(workspaceId);
        }
      }

      for (const workspaceId of Array.from(pendingWorkspaces)) {
        if (stopped) break;
        try {
          await ports.openPanel(workspaceId);
          pendingWorkspaces.delete(workspaceId);
          openedWorkspaces.add(workspaceId);
        } catch {
          // Keep workspaceId in pendingWorkspaces if openPanel throws,
          // so temporary context unavailability retries on the next poll.
        }
      }

      cursor = result.cursor;
    } catch {
      // Retain current cursor and pending items on transport/poll error
    } finally {
      pollInFlight = false;
      if (!stopped) {
        scheduleNextPoll(intervalMs);
      }
    }
  }

  scheduleNextPoll(0);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
    },
    get isRunning() {
      return !stopped;
    },
  };
}
