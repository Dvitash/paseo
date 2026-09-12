import {
  QueryClient,
  QueryObserver,
  skipToken,
  timeoutManager,
  type ManagedTimerId,
  type QueryKey,
  type TimeoutCallback,
  type TimeoutProvider,
} from "@tanstack/react-query";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REPLICA_QUERY_GC_TIME_MS, replicaQueryOptions } from "./query";

interface ReplicaPayload {
  files: string[];
  requestId: string;
}

interface ScheduledTimer {
  id: number;
  callback: TimeoutCallback;
  dueAt: number;
  intervalMs: number | null;
}

interface ManualTimeoutProvider {
  provider: TimeoutProvider<number>;
  advance(ms: number): void;
  reset(): void;
}

// Query core routes every stale, retry, and gc timer through timeoutManager, so replacing its
// provider is the whole clock a collection test needs. Notifications keep the platform timer.
function createManualTimeoutProvider(): ManualTimeoutProvider {
  const timers = new Map<number, ScheduledTimer>();
  let nextId = 1;
  let now = 0;

  function schedule(callback: TimeoutCallback, delay: number, intervalMs: number | null): number {
    const id = nextId++;
    timers.set(id, { id, callback, dueAt: now + delay, intervalMs });
    return id;
  }

  function advance(ms: number): void {
    const target = now + ms;
    for (;;) {
      const due = [...timers.values()]
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!due) {
        break;
      }
      now = due.dueAt;
      if (due.intervalMs === null) {
        timers.delete(due.id);
      } else {
        due.dueAt += due.intervalMs;
      }
      due.callback();
    }
    now = target;
  }

  return {
    provider: {
      setTimeout: (callback, delay) => schedule(callback, delay, null),
      clearTimeout: (timeoutId) => {
        if (typeof timeoutId === "number") {
          timers.delete(timeoutId);
        }
      },
      setInterval: (callback, delay) => schedule(callback, delay, delay),
      clearInterval: (intervalId) => {
        if (typeof intervalId === "number") {
          timers.delete(intervalId);
        }
      },
    },
    advance,
    reset() {
      timers.clear();
      now = 0;
    },
  };
}

const systemTimeouts: TimeoutProvider<ManagedTimerId> = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timeoutId) => clearTimeout(timeoutId as Parameters<typeof clearTimeout>[0]),
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (intervalId) => clearInterval(intervalId as Parameters<typeof clearInterval>[0]),
};

interface ReplicaObserverInput {
  queryClient: QueryClient;
  queryKey: QueryKey;
  pushEvent: string;
  queryFn: () => Promise<ReplicaPayload>;
  enabled?: boolean;
}

// A mounted replica settles its first fetch before this resolves, so assertions read the delivered
// payload instead of racing the retryer.
async function awaitReplicaFetch(queryClient: QueryClient, queryKey: QueryKey): Promise<void> {
  await queryClient.getQueryCache().find({ queryKey, exact: true })?.promise;
}

function mountReplicaObserver(
  input: ReplicaObserverInput,
): QueryObserver<ReplicaPayload, Error, ReplicaPayload, ReplicaPayload> {
  return new QueryObserver<ReplicaPayload, Error, ReplicaPayload, ReplicaPayload>(
    input.queryClient,
    replicaQueryOptions<ReplicaPayload, Error, ReplicaPayload, QueryKey>({
      queryKey: input.queryKey,
      pushEvent: input.pushEvent,
      queryFn: input.queryFn,
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    }),
  );
}

let manualTimeouts: ManualTimeoutProvider;

beforeAll(() => {
  manualTimeouts = createManualTimeoutProvider();
  timeoutManager.setTimeoutProvider(manualTimeouts.provider);
});

afterAll(() => {
  timeoutManager.setTimeoutProvider(systemTimeouts);
});

beforeEach(() => {
  manualTimeouts.reset();
});

describe("replica query policy", () => {
  it("retains an unobserved replica for one minute while keeping push semantics", () => {
    const options = replicaQueryOptions({ queryKey: ["replica", "policy"], pushEvent: "pushed" });

    expect(options.gcTime).toBe(60_000);
    expect(REPLICA_QUERY_GC_TIME_MS).toBe(60_000);
    expect(options.staleTime).toBe(Infinity);
    expect(options.queryFn).toBe(skipToken);
    expect(options.refetchOnMount).toBe(false);
    expect(options.refetchOnReconnect).toBe(false);
    expect(options.refetchOnWindowFocus).toBe(false);
    expect(options.meta).toEqual({
      serverDataPolicy: { class: "replica", pushEvent: "pushed" },
    });
  });

  it("cancels collection when the replica is reobserved before the minute elapses", async () => {
    const queryClient = new QueryClient();
    const queryKey: QueryKey = ["checkoutDiff", "server-1", "/repo"];
    let fetchCount = 0;
    const queryFn = async (): Promise<ReplicaPayload> => {
      fetchCount++;
      return { files: [`file-${fetchCount}`], requestId: `fetch-${fetchCount}` };
    };
    const observer = mountReplicaObserver({
      queryClient,
      queryKey,
      pushEvent: "checkout_diff_update",
      queryFn,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await awaitReplicaFetch(queryClient, queryKey);

    unsubscribe();
    manualTimeouts.advance(REPLICA_QUERY_GC_TIME_MS - 1);

    const reobservedObserver = mountReplicaObserver({
      queryClient,
      queryKey,
      pushEvent: "checkout_diff_update",
      queryFn,
    });
    const reobservedUnsubscribe = reobservedObserver.subscribe(() => undefined);
    manualTimeouts.advance(REPLICA_QUERY_GC_TIME_MS * 2);

    expect(queryClient.getQueryData<ReplicaPayload>(queryKey)?.requestId).toBe("fetch-1");
    expect(reobservedObserver.getCurrentResult().data?.requestId).toBe("fetch-1");
    expect(fetchCount).toBe(1);
    expect(reobservedObserver.getCurrentQuery().getObserversCount()).toBe(1);

    reobservedUnsubscribe();
  });

  it("collects the replica after a minute unobserved and refetches current state on remount", async () => {
    const queryClient = new QueryClient();
    const queryKey: QueryKey = ["checkoutDiff", "server-1", "/repo"];
    let fetchCount = 0;
    const queryFn = async (): Promise<ReplicaPayload> => {
      fetchCount++;
      return { files: [`file-${fetchCount}`], requestId: `fetch-${fetchCount}` };
    };

    const firstObserver = mountReplicaObserver({
      queryClient,
      queryKey,
      pushEvent: "checkout_diff_update",
      queryFn,
    });
    const firstUnsubscribe = firstObserver.subscribe(() => undefined);
    await awaitReplicaFetch(queryClient, queryKey);
    expect(queryClient.getQueryData<ReplicaPayload>(queryKey)?.requestId).toBe("fetch-1");

    firstUnsubscribe();
    manualTimeouts.advance(REPLICA_QUERY_GC_TIME_MS - 1);
    expect(queryClient.getQueryData<ReplicaPayload>(queryKey)?.requestId).toBe("fetch-1");

    manualTimeouts.advance(1);
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();

    const remountedObserver = mountReplicaObserver({
      queryClient,
      queryKey,
      pushEvent: "checkout_diff_update",
      queryFn,
    });
    const remountUnsubscribe = remountedObserver.subscribe(() => undefined);
    await awaitReplicaFetch(queryClient, queryKey);

    expect(remountedObserver.getCurrentResult().data).toEqual({
      files: ["file-2"],
      requestId: "fetch-2",
    });

    remountUnsubscribe();
  });

  it("keeps a disabled mounted replica alive and consistent with push updates", () => {
    const queryClient = new QueryClient();
    const queryKey: QueryKey = ["terminals", "server-1", "/repo", "workspace-a"];
    const queryFn = async (): Promise<ReplicaPayload> => ({ files: [], requestId: "fetched" });
    const retainedObserver = mountReplicaObserver({
      queryClient,
      queryKey,
      pushEvent: "terminals_changed",
      queryFn,
      enabled: false,
    });
    const retainedUnsubscribe = retainedObserver.subscribe(() => undefined);
    queryClient.setQueryData<ReplicaPayload>(queryKey, { files: ["pushed"], requestId: "push-1" });

    manualTimeouts.advance(REPLICA_QUERY_GC_TIME_MS * 2);

    expect(retainedObserver.getCurrentQuery().getObserversCount()).toBe(1);
    expect(retainedObserver.getCurrentResult().data).toEqual({
      files: ["pushed"],
      requestId: "push-1",
    });

    queryClient.setQueryData<ReplicaPayload>(queryKey, { files: ["newer"], requestId: "push-2" });
    expect(retainedObserver.getCurrentResult().data).toEqual({
      files: ["newer"],
      requestId: "push-2",
    });

    retainedUnsubscribe();
    manualTimeouts.advance(REPLICA_QUERY_GC_TIME_MS);
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();

    queryClient.setQueryData<ReplicaPayload>(queryKey, {
      files: ["after-gc"],
      requestId: "push-3",
    });
    const remountedObserver = mountReplicaObserver({
      queryClient,
      queryKey,
      pushEvent: "terminals_changed",
      queryFn,
    });
    const remountUnsubscribe = remountedObserver.subscribe(() => undefined);

    expect(remountedObserver.getCurrentResult().data).toEqual({
      files: ["after-gc"],
      requestId: "push-3",
    });
    expect(remountedObserver.getCurrentResult().isFetching).toBe(false);

    queryClient.setQueryData<ReplicaPayload>(queryKey, { files: ["push-4"], requestId: "push-4" });
    expect(remountedObserver.getCurrentResult().data).toEqual({
      files: ["push-4"],
      requestId: "push-4",
    });

    remountUnsubscribe();
  });
});
