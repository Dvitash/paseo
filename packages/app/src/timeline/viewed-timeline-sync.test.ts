import { expect, test, vi } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { ProjectedTimelineForwardFetchPlan } from "./timeline-sync-plan";
import {
  consumeForcedTimelineTailReplacement,
  createTimelineReplica,
  createViewedTimelineOwner,
  createViewedTimelineSync,
  type TimelineResponsePayload,
} from "./viewed-timeline-sync";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface MembershipRequest {
  agentIds: string[];
  succeed(): void;
  fail(message: string): void;
}

interface TimelineFetch {
  agentId: string;
  request: ProjectedTimelineForwardFetchPlan;
  respond(input: { hasNewer: boolean; seq?: number }): void;
  fail(message: string): void;
}

class TimelineWorld {
  readonly errors: string[] = [];
  readonly cursors = new Map<string, { epoch: string; endSeq: number }>();
  readonly cacheRequests: string[] = [];
  readonly forcedTimelineTailReplacements = new Set<string>();
  /** Agents whose transcript the injected release port refuses to drop. */
  readonly blockedReleases = new Set<string>();
  readonly releaseAttempts: string[] = [];
  readonly released: string[] = [];
  cacheGate: Deferred<void> | null = null;
  readonly sync = createViewedTimelineSync({
    replaceDemandedAgentIds: () => undefined,
    releaseTranscript: (agentId) => {
      this.releaseAttempts.push(agentId);
      if (this.blockedReleases.has(agentId)) return false;
      this.released.push(agentId);
      return true;
    },
    prepare: async (agentId) => {
      this.cacheRequests.push(agentId);
      this.cacheRequestWaiters.shift()?.(agentId);
      await this.cacheGate?.promise;
    },
    initialDeliveryMode: "selective",
    setSubscription: async (agentIds) => {
      const result = deferred<void>();
      this.memberships.push({
        agentIds,
        succeed: () => result.resolve(),
        fail: (message) => result.reject(new Error(message)),
      });
      this.releaseMembershipWaiter();
      return result.promise;
    },
    readCursor: (agentId) => this.cursors.get(agentId),
    fetchPage: async (agentId, request) => {
      const result = deferred<{
        hasNewer: boolean;
        endCursor: { epoch: string; seq: number } | null;
      }>();
      this.fetches.push({
        agentId,
        request,
        respond: ({ hasNewer, seq = 1 }) =>
          result.resolve({
            hasNewer,
            endCursor: { epoch: `epoch-${agentId}`, seq },
          }),
        fail: (message) => result.reject(new Error(message)),
      });
      this.releaseFetchWaiters();
      return result.promise;
    },
    fetchLatestTail: async (agentId) => {
      this.forcedTimelineTailReplacements.add(agentId);
      try {
        return await this.fetchTimeline(agentId, {
          direction: "tail",
          limit: 40,
          projection: "projected",
        });
      } finally {
        this.forcedTimelineTailReplacements.delete(agentId);
      }
    },
    reportError: (error) => {
      this.errors.push(error instanceof Error ? error.message : String(error));
      const waiter = this.errorWaiters.shift();
      if (waiter) waiter(this.errors.at(-1) ?? "");
    },
    schedule: (task, delayMs) => {
      const scheduled = { task, delayMs };
      this.scheduled.push(scheduled);
      const waiterIndex = this.retryWaiters.findIndex((waiter) => waiter.delayMs === delayMs);
      if (waiterIndex >= 0) {
        const [waiter] = this.retryWaiters.splice(waiterIndex, 1);
        this.scheduled.splice(this.scheduled.indexOf(scheduled), 1);
        waiter.resolve(task);
      }
      return () => {
        const index = this.scheduled.indexOf(scheduled);
        if (index >= 0) this.scheduled.splice(index, 1);
      };
    },
  });

  private readonly memberships: MembershipRequest[] = [];
  private readonly membershipWaiters: Array<(request: MembershipRequest) => void> = [];
  private readonly fetches: TimelineFetch[] = [];
  private readonly fetchWaiters: Array<{
    agentId: string;
    resolve(fetch: TimelineFetch): void;
  }> = [];
  private readonly errorWaiters: Array<(message: string) => void> = [];
  private readonly cacheRequestWaiters: Array<(agentId: string) => void> = [];
  private readonly scheduled: Array<{ task: () => void; delayMs: number }> = [];
  private readonly retryWaiters: Array<{
    delayMs: number;
    resolve(retry: () => void): void;
  }> = [];

  get pendingFetchCount(): number {
    return this.fetches.length;
  }

  applyTimelineResponse(payload: TimelineResponsePayload): TimelineResponsePayload {
    return consumeForcedTimelineTailReplacement(payload, this.forcedTimelineTailReplacements);
  }

  nextCacheRequest(): Promise<string> {
    const request = this.cacheRequests.at(-1);
    if (request) return Promise.resolve(request);
    return new Promise((resolve) => this.cacheRequestWaiters.push(resolve));
  }

  private fetchTimeline(
    agentId: string,
    request: ProjectedTimelineForwardFetchPlan,
  ): Promise<{ hasNewer: boolean; endCursor: { epoch: string; seq: number } | null }> {
    const result = deferred<{
      hasNewer: boolean;
      endCursor: { epoch: string; seq: number } | null;
    }>();
    this.fetches.push({
      agentId,
      request,
      respond: ({ hasNewer, seq = 1 }) =>
        result.resolve({ hasNewer, endCursor: { epoch: `epoch-${agentId}`, seq } }),
      fail: (message) => result.reject(new Error(message)),
    });
    this.releaseFetchWaiters();
    return result.promise;
  }

  nextMembership(): Promise<MembershipRequest> {
    const request = this.memberships.shift();
    if (request) return Promise.resolve(request);
    return new Promise((resolve) => this.membershipWaiters.push(resolve));
  }

  nextFetch(agentId: string): Promise<TimelineFetch> {
    const index = this.fetches.findIndex((fetch) => fetch.agentId === agentId);
    if (index >= 0) return Promise.resolve(this.fetches.splice(index, 1)[0]);
    return new Promise((resolve) => this.fetchWaiters.push({ agentId, resolve }));
  }

  takeFetch(agentId: string): TimelineFetch | null {
    const index = this.fetches.findIndex((fetch) => fetch.agentId === agentId);
    return index >= 0 ? this.fetches.splice(index, 1)[0] : null;
  }

  expectNoPendingMembership(): void {
    expect(this.memberships).toEqual([]);
  }

  expectNoPendingFetch(): void {
    expect(this.fetches).toEqual([]);
  }

  nextError(): Promise<string> {
    const message = this.errors.at(-1);
    if (message) return Promise.resolve(message);
    return new Promise((resolve) => this.errorWaiters.push(resolve));
  }

  nextRetry(delayMs = 1_000): Promise<() => void> {
    const index = this.scheduled.findIndex((entry) => entry.delayMs === delayMs);
    if (index >= 0) return Promise.resolve(this.scheduled.splice(index, 1)[0].task);
    return new Promise((resolve) => this.retryWaiters.push({ delayMs, resolve }));
  }

  elapse(elapsedMs: number): void {
    const due = this.scheduled.filter((entry) => entry.delayMs <= elapsedMs);
    this.scheduled.splice(
      0,
      this.scheduled.length,
      ...this.scheduled.filter((entry) => entry.delayMs > elapsedMs),
    );
    for (const entry of due) entry.task();
  }

  private releaseMembershipWaiter(): void {
    const waiter = this.membershipWaiters.shift();
    if (!waiter) return;
    const request = this.memberships.shift();
    if (request) waiter(request);
  }

  private releaseFetchWaiters(): void {
    for (let waiterIndex = this.fetchWaiters.length - 1; waiterIndex >= 0; waiterIndex -= 1) {
      const waiter = this.fetchWaiters[waiterIndex];
      const index = this.fetches.findIndex((fetch) => fetch.agentId === waiter.agentId);
      if (index < 0) continue;
      this.fetchWaiters.splice(waiterIndex, 1);
      waiter.resolve(this.fetches.splice(index, 1)[0]);
    }
  }
}

test("uses a tail fetch when an agent becomes visible", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const fetch = await world.nextFetch("agent-a");
  expect(fetch.request).toEqual({ direction: "tail", limit: 40, projection: "projected" });
  fetch.respond({ hasNewer: false });
});

test("loads the cache before choosing the authoritative network request", async () => {
  const world = new TimelineWorld();
  world.cacheGate = deferred<void>();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const cacheRequest = await world.nextCacheRequest();

  expect(cacheRequest).toBe("agent-a");
  expect(world.pendingFetchCount).toBe(0);

  world.cursors.set("agent-a", { epoch: "cached-epoch", endSeq: 17 });
  world.cacheGate.resolve();
  const fetch = await world.nextFetch("agent-a");

  expect(fetch.request).toEqual({
    direction: "after",
    cursor: { epoch: "cached-epoch", seq: 17 },
    limit: 40,
    projection: "projected",
  });
  fetch.respond({ hasNewer: false });
});

test("catches up after the restored cursor when an agent becomes visible", async () => {
  const world = new TimelineWorld();
  world.cursors.set("agent-a", { epoch: "epoch-agent-a", endSeq: 42 });
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const fetch = await world.nextFetch("agent-a");
  expect(fetch.request).toEqual({
    direction: "after",
    cursor: { epoch: "epoch-agent-a", seq: 42 },
    limit: 40,
    projection: "projected",
  });
  fetch.respond({ hasNewer: false });
});

test("falls back to the latest tail when a restored cursor has more than one catch-up page", async () => {
  const world = new TimelineWorld();
  world.cursors.set("agent-a", { epoch: "epoch-agent-a", endSeq: 42 });
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const probe = await world.nextFetch("agent-a");
  expect(probe.request.direction).toBe("after");
  probe.respond({ hasNewer: true, seq: 82 });

  const fallback = await world.nextFetch("agent-a");
  expect(fallback.request).toEqual({ direction: "tail", limit: 40, projection: "projected" });
  expect(
    world.applyTimelineResponse({
      requestId: "fallback-tail",
      agentId: "agent-a",
      agent: null,
      direction: "tail",
      projection: "projected",
      epoch: "epoch-agent-a",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 43, maxSeq: 82, nextSeq: 83 },
      startCursor: { epoch: "epoch-agent-a", seq: 43 },
      endCursor: { epoch: "epoch-agent-a", seq: 82 },
      hasOlder: true,
      hasNewer: false,
      entries: [],
      error: null,
    }).reset,
  ).toBe(true);
  fallback.respond({ hasNewer: false });
});

test("a gap absorbed by a running tail is recovered after the tail completes", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const tail = await world.nextFetch("agent-a");

  world.sync.recoverGap("agent-a", { epoch: "epoch-agent-a", endSeq: 9 });

  world.expectNoPendingFetch();
  tail.respond({ hasNewer: false });

  const recovery = await world.nextFetch("agent-a");
  expect(recovery.request).toEqual({
    direction: "after",
    cursor: { epoch: "epoch-agent-a", seq: 9 },
    limit: 40,
    projection: "projected",
  });
  recovery.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));
});

test("unchanged visible-set publication does not cancel paged catch-up", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("pending");
  const membership = await world.nextMembership();
  membership.succeed();
  const firstPage = await world.nextFetch("agent-a");

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a", "agent-a"]);
  firstPage.respond({ hasNewer: true, seq: 5 });
  const secondPage = await world.nextFetch("agent-a");
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("pending");
  secondPage.respond({ hasNewer: false });

  await vi.waitFor(() => {
    expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready");
  });

  expect(secondPage.request).toEqual({
    direction: "after",
    cursor: { epoch: "epoch-agent-a", seq: 5 },
    limit: 40,
    projection: "projected",
  });
  world.expectNoPendingMembership();
});

test("all acknowledged agents begin catch-up independently", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-b", "agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const [agentA, agentB] = await Promise.all([
    world.nextFetch("agent-a"),
    world.nextFetch("agent-b"),
  ]);
  agentA.respond({ hasNewer: false });
  agentB.respond({ hasNewer: false });

  expect(membership.agentIds).toEqual(["agent-a", "agent-b"]);
});

test("an eviction during acknowledgement never catches up the stale hot set", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", [
    "agent-a",
    "agent-b",
    "agent-c",
    "agent-d",
    "agent-e",
  ]);
  const staleMembership = await world.nextMembership();
  world.sync.replaceVisibleAgentIds("workspace", ["agent-f"]);
  staleMembership.succeed();
  const currentMembership = await world.nextMembership();
  currentMembership.succeed();
  const currentCatchUps = await Promise.all(
    ["agent-a", "agent-b", "agent-c", "agent-d", "agent-f"].map((agentId) =>
      world.nextFetch(agentId),
    ),
  );
  for (const catchUp of currentCatchUps) catchUp.respond({ hasNewer: false });

  expect({ stale: staleMembership.agentIds, current: currentMembership.agentIds }).toEqual({
    stale: ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e"],
    current: ["agent-a", "agent-b", "agent-c", "agent-d", "agent-f"],
  });
  world.expectNoPendingFetch();
});

test("disconnect cancels paging and reconnect restores membership before fresh catch-up", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const firstMembership = await world.nextMembership();
  firstMembership.succeed();
  const stalePage = await world.nextFetch("agent-a");

  world.sync.setConnected(false);
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("pending");
  stalePage.respond({ hasNewer: true, seq: 8 });
  world.sync.setConnected(true);
  const restoredMembership = await world.nextMembership();
  restoredMembership.succeed();
  const restoredPage = await world.nextFetch("agent-a");
  restoredPage.respond({ hasNewer: false });

  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  expect(restoredMembership.agentIds).toEqual(["agent-a"]);
  world.expectNoPendingFetch();
});

test("navigation while disconnected reconnects only the currently visible agent", async () => {
  const world = new TimelineWorld();
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);

  world.sync.setConnected(true);
  const membership = await world.nextMembership();
  membership.succeed();
  const catchUp = await world.nextFetch("agent-b");
  catchUp.respond({ hasNewer: false });

  expect(membership.agentIds).toEqual(["agent-b"]);
  world.expectNoPendingFetch();
});

test("overlapping sources deduplicate membership and retain hidden hot agents", async () => {
  const world = new TimelineWorld();
  world.sync.replaceVisibleAgentIds("left-route", ["agent-a"]);
  world.sync.replaceVisibleAgentIds("right-route", ["agent-a", "agent-b"]);
  world.sync.setConnected(true);
  const combined = await world.nextMembership();
  combined.succeed();
  const [agentA, agentB] = await Promise.all([
    world.nextFetch("agent-a"),
    world.nextFetch("agent-b"),
  ]);
  agentA.respond({ hasNewer: false });
  agentB.respond({ hasNewer: false });

  world.sync.replaceVisibleAgentIds("left-route", []);
  world.expectNoPendingMembership();
  world.sync.replaceVisibleAgentIds("right-route", ["agent-b"]);

  expect(combined.agentIds).toEqual(["agent-a", "agent-b"]);
  world.expectNoPendingMembership();
  world.expectNoPendingFetch();
});

test("a failed catch-up reports once and retries through the explicit retry policy", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const failed = await world.nextFetch("agent-a");
  failed.fail("timeline unavailable");
  const [error, retryCatchUp] = await Promise.all([world.nextError(), world.nextRetry()]);
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");

  retryCatchUp();
  const retry = await world.nextFetch("agent-a");
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");
  retry.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  expect({ error, retryDirection: retry.request.direction }).toEqual({
    error: "timeline unavailable",
    retryDirection: "tail",
  });
  world.expectNoPendingMembership();
});

test("a failed catch-up retries with exponential backoff", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const first = await world.nextFetch("agent-a");
  first.fail("timeline unavailable");
  const [firstError, retryAfterFirstFailure] = await Promise.all([
    world.nextError(),
    world.nextRetry(),
  ]);
  expect(firstError).toBe("timeline unavailable");
  retryAfterFirstFailure();

  const second = await world.nextFetch("agent-a");
  second.fail("timeline unavailable");
  await world.nextError();

  const retryAfterSecondFailure = await world.nextRetry(2_000);
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");

  retryAfterSecondFailure();
  const third = await world.nextFetch("agent-a");
  third.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));
});

test("manual retries can immediately re-attempt a failed catch-up", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const failed = await world.nextFetch("agent-a");
  failed.fail("timeline unavailable");
  await world.nextRetry();
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");

  world.sync.retryVisibleAgentTimeline("agent-a");
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("retrying");

  const retry = await world.nextFetch("agent-a");
  retry.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));
});

test("redeclaring unchanged visibility does not bypass catch-up backoff", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const failed = await world.nextFetch("agent-a");
  failed.fail("timeline unavailable");
  await world.nextRetry();

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);

  world.expectNoPendingMembership();
  world.expectNoPendingFetch();
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");
});

test("a manual retry that fails returns to the error state", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  const failed = await world.nextFetch("agent-a");
  failed.fail("timeline unavailable");
  await world.nextRetry();

  world.sync.retryVisibleAgentTimeline("agent-a");
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("retrying");

  const retry = await world.nextFetch("agent-a");
  retry.fail("timeline still unavailable");
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error"));
});

test("gap recovery supersedes completed catch-up and pages through the current tail", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const initial = await world.nextFetch("agent-a");
  initial.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.recoverGap("agent-a", { epoch: "epoch-agent-a", endSeq: 10 });
  const gapPage = await world.nextFetch("agent-a");
  gapPage.respond({ hasNewer: true, seq: 15 });
  const finalPage = await world.nextFetch("agent-a");
  finalPage.respond({ hasNewer: false });

  expect([gapPage.request, finalPage.request]).toEqual([
    {
      direction: "after",
      cursor: { epoch: "epoch-agent-a", seq: 10 },
      limit: 40,
      projection: "projected",
    },
    {
      direction: "after",
      cursor: { epoch: "epoch-agent-a", seq: 15 },
      limit: 40,
      projection: "projected",
    },
  ]);
});

test("repeated recovery for the same running gap reuses the in-flight fetch", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const initial = await world.nextFetch("agent-a");
  initial.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  const cursor = { epoch: "epoch-agent-a", endSeq: 10 };
  world.sync.recoverGap("agent-a", cursor);
  const gapPage = await world.nextFetch("agent-a");
  world.sync.recoverGap("agent-a", cursor);

  world.expectNoPendingFetch();
  gapPage.respond({ hasNewer: false });
});

test("membership failure autonomously retries without another visibility declaration", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const failed = await world.nextMembership();
  failed.fail("subscription unavailable");
  const [error, retryMembership] = await Promise.all([world.nextError(), world.nextRetry()]);
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");

  retryMembership();
  const retry = await world.nextMembership();
  retry.succeed();
  const catchUp = await world.nextFetch("agent-a");
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");
  catchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  expect({ error, failed: failed.agentIds, retry: retry.agentIds }).toEqual({
    error: "subscription unavailable",
    failed: ["agent-a"],
    retry: ["agent-a"],
  });
});

test("membership failures retry with exponential backoff", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);

  const first = await world.nextMembership();
  first.fail("subscription unavailable");
  const [firstError, retryAfterFirstFailure] = await Promise.all([
    world.nextError(),
    world.nextRetry(),
  ]);
  expect(firstError).toBe("subscription unavailable");

  retryAfterFirstFailure();
  const second = await world.nextMembership();
  second.fail("subscription unavailable again");

  const retryAfterSecondFailure = await world.nextRetry(2_000);
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");

  retryAfterSecondFailure();
  const retry = await world.nextMembership();
  retry.succeed();
  const catchUp = await world.nextFetch("agent-a");
  catchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));
});

test("redeclaring unchanged visibility does not bypass membership backoff", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);

  const failed = await world.nextMembership();
  failed.fail("subscription unavailable");
  await world.nextRetry();

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);

  world.expectNoPendingMembership();
  world.expectNoPendingFetch();
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");
});

test("backgrounding preserves the hot membership and resumes only the visible agent", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const agentAMembership = await world.nextMembership();
  agentAMembership.succeed();
  const agentACatchUp = await world.nextFetch("agent-a");
  agentACatchUp.respond({ hasNewer: false });

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const agentBMembership = await world.nextMembership();
  agentBMembership.succeed();
  const agentBCatchUp = await world.nextFetch("agent-b");
  agentBCatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-b")).toBe("ready"));

  world.sync.setActive(false);
  world.expectNoPendingMembership();
  world.elapse(60_000);
  world.sync.setActive(true);

  world.expectNoPendingMembership();
  const resumed = await world.nextFetch("agent-b");
  expect(resumed.request).toEqual({ direction: "tail", limit: 40, projection: "projected" });
  resumed.respond({ hasNewer: false });
  expect(world.takeFetch("agent-a")).toBeNull();
  world.expectNoPendingFetch();
});

test("resuming during an in-flight catch-up parks exactly one follow-up tail", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();

  // A selective stream survives backgrounding, so the catch-up started before background can
  // still be in flight when the app comes back.
  const inFlight = await world.nextFetch("agent-a");
  world.sync.setActive(false);
  world.sync.setActive(true);

  // The pre-background request may have snapshotted before inactivity, so it is not reused.
  world.expectNoPendingFetch();
  world.expectNoPendingMembership();

  inFlight.respond({ hasNewer: false });

  const followUp = await world.nextFetch("agent-a");
  expect(followUp.request).toEqual({ direction: "tail", limit: 40, projection: "projected" });
  followUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));
  world.expectNoPendingFetch();
});

test("resume after in-app navigation refreshes only the newly visible agent", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const agentACatchUp = await world.nextFetch("agent-a");
  agentACatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  // Backgrounding alone never publishes, and neither does the navigation that follows it.
  world.sync.setActive(false);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  world.expectNoPendingMembership();
  world.expectNoPendingFetch();

  world.sync.setActive(true);
  const resumedMembership = await world.nextMembership();
  resumedMembership.succeed();
  const agentBCatchUp = await world.nextFetch("agent-b");
  expect(agentBCatchUp.request).toEqual({ direction: "tail", limit: 40, projection: "projected" });
  agentBCatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-b")).toBe("ready"));

  // The retained hidden agent keeps its live stream and is not refreshed.
  expect(world.takeFetch("agent-a")).toBeNull();
  world.expectNoPendingFetch();
  expect(resumedMembership.agentIds).toEqual(["agent-a", "agent-b"]);
});

test("an already-active foreground never re-fetches", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const initial = await world.nextFetch("agent-a");
  initial.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.setActive(true);
  expect(world.takeFetch("agent-a")).toBeNull();

  // A resumed agent settles once; repeating active=true must not owe another tail.
  world.sync.setActive(false);
  world.sync.setActive(true);
  const resumed = await world.nextFetch("agent-a");
  resumed.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.setActive(true);
  expect(world.takeFetch("agent-a")).toBeNull();
  world.expectNoPendingMembership();
});

test("resuming retries a failed visible catch-up without another visibility declaration", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const failed = await world.nextFetch("agent-a");
  failed.fail("timeline unavailable");
  await world.nextRetry();
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("error");

  world.sync.setActive(false);
  world.sync.setActive(true);

  const resumed = await world.nextFetch("agent-a");
  expect(resumed.request).toEqual({ direction: "tail", limit: 40, projection: "projected" });
  resumed.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));
  world.expectNoPendingMembership();
});

test("stale membership retry cannot overwrite a newer effective set", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const failed = await world.nextMembership();
  failed.fail("subscription unavailable");
  const staleRetry = await world.nextRetry();

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const current = await world.nextMembership();
  staleRetry();
  current.succeed();
  const [agentA, agentB] = await Promise.all([
    world.nextFetch("agent-a"),
    world.nextFetch("agent-b"),
  ]);
  agentA.respond({ hasNewer: false });
  agentB.respond({ hasNewer: false });

  expect(current.agentIds).toEqual(["agent-a", "agent-b"]);
  world.expectNoPendingMembership();
});

test("membership retry cannot run while disconnected", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const failed = await world.nextMembership();
  failed.fail("subscription unavailable");
  const disconnectedRetry = await world.nextRetry();

  world.sync.setConnected(false);
  disconnectedRetry();
  world.expectNoPendingMembership();
  world.sync.setConnected(true);
  const restored = await world.nextMembership();
  restored.succeed();
  const catchUp = await world.nextFetch("agent-a");
  catchUp.respond({ hasNewer: false });

  expect(restored.agentIds).toEqual(["agent-a"]);
});

test("returning to a hot hidden agent stays live after inactivity", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const initialMembership = await world.nextMembership();
  initialMembership.succeed();
  const agentACatchUp = await world.nextFetch("agent-a");
  agentACatchUp.respond({ hasNewer: false });

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const expandedMembership = await world.nextMembership();
  expandedMembership.succeed();
  const agentBCatchUp = await world.nextFetch("agent-b");
  agentBCatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-b")).toBe("ready"));

  world.elapse(60_000);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);

  world.expectNoPendingMembership();
  world.expectNoPendingFetch();
});

test("the hot set evicts the least-recent hidden agent and promotes revisited agents", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  for (const agentId of ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e"]) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    const membership = await world.nextMembership();
    membership.succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
    await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus(agentId)).toBe("ready"));
  }

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  world.expectNoPendingMembership();
  world.expectNoPendingFetch();

  world.sync.replaceVisibleAgentIds("workspace", ["agent-f"]);
  const eviction = await world.nextMembership();
  eviction.succeed();
  const agentFCatchUp = await world.nextFetch("agent-f");
  agentFCatchUp.respond({ hasNewer: false });
  expect(eviction.agentIds).toEqual(["agent-b", "agent-c", "agent-d", "agent-e", "agent-f"]);

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  world.expectNoPendingMembership();
  world.expectNoPendingFetch();

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const restoreEvicted = await world.nextMembership();
  restoreEvicted.succeed();
  const agentACatchUp = await world.nextFetch("agent-a");
  agentACatchUp.respond({ hasNewer: false });
  expect(restoreEvicted.agentIds).toEqual(["agent-a", "agent-b", "agent-d", "agent-e", "agent-f"]);
});

test("visible agents are never evicted when they exceed the hot-set limit", async () => {
  const world = new TimelineWorld();
  const visible = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f"];
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", visible);
  const membership = await world.nextMembership();
  membership.succeed();
  const catchUps = await Promise.all(visible.map((agentId) => world.nextFetch(agentId)));
  for (const catchUp of catchUps) catchUp.respond({ hasNewer: false });

  expect(membership.agentIds).toEqual(visible);

  world.sync.replaceVisibleAgentIds("workspace", visible.slice(0, 5));
  const hiddenEviction = await world.nextMembership();
  hiddenEviction.succeed();
  expect(hiddenEviction.agentIds).toEqual(visible.slice(0, 5));
});

test("disconnect clears hidden hot agents before reconnecting the visible set", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const agentAMembership = await world.nextMembership();
  agentAMembership.succeed();
  const agentACatchUp = await world.nextFetch("agent-a");
  agentACatchUp.respond({ hasNewer: false });

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const agentBMembership = await world.nextMembership();
  agentBMembership.succeed();
  const agentBCatchUp = await world.nextFetch("agent-b");
  agentBCatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-b")).toBe("ready"));

  world.sync.setConnected(false);
  world.expectNoPendingMembership();
  world.sync.setConnected(true);
  const restored = await world.nextMembership();
  restored.succeed();
  const restoredCatchUp = await world.nextFetch("agent-b");
  restoredCatchUp.respond({ hasNewer: false });

  expect(restored.agentIds).toEqual(["agent-b"]);

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const reopened = await world.nextMembership();
  reopened.succeed();
  const reopenedCatchUp = await world.nextFetch("agent-a");
  reopenedCatchUp.respond({ hasNewer: false });
  expect(reopened.agentIds).toEqual(["agent-a", "agent-b"]);
});

test("legacy delivery skips subscription RPCs while retaining visibility catch-up and gap recovery", async () => {
  const world = new TimelineWorld();
  world.sync.setDeliveryMode("legacy");
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  world.sync.setConnected(true);

  world.expectNoPendingMembership();
  const initial = await world.nextFetch("agent-a");
  initial.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.recoverGap("agent-a", { epoch: "epoch-agent-a", endSeq: 10 });
  const recovery = await world.nextFetch("agent-a");
  recovery.respond({ hasNewer: false });

  expect(recovery.request).toEqual({
    direction: "after",
    cursor: { epoch: "epoch-agent-a", seq: 10 },
    limit: 40,
    projection: "projected",
  });
});

test("legacy delivery catches up after returning to a view or foreground", async () => {
  const world = new TimelineWorld();
  world.sync.setDeliveryMode("legacy");
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const firstAgentA = await world.nextFetch("agent-a");
  firstAgentA.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.replaceVisibleAgentIds("workspace", ["agent-b"]);
  const agentB = await world.nextFetch("agent-b");
  agentB.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-b")).toBe("ready"));

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const secondAgentA = await world.nextFetch("agent-a");
  secondAgentA.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.setActive(false);
  world.sync.setActive(true);
  const foregroundAgentA = await world.nextFetch("agent-a");
  foregroundAgentA.respond({ hasNewer: false });

  world.expectNoPendingMembership();
});

test("switching from legacy to selective delivery publishes membership and catches up once", async () => {
  const world = new TimelineWorld();
  world.sync.setDeliveryMode("legacy");
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  world.sync.setConnected(true);
  const legacyCatchUp = await world.nextFetch("agent-a");
  legacyCatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  world.sync.setDeliveryMode("selective");
  expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("pending");
  const membership = await world.nextMembership();
  membership.succeed();
  const catchUp = await world.nextFetch("agent-a");
  catchUp.respond({ hasNewer: false });

  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  expect(membership.agentIds).toEqual(["agent-a"]);
  world.expectNoPendingMembership();
  world.expectNoPendingFetch();
});

const RELEASE_WORKLOAD_AGENT_IDS = [
  "agent-a",
  "agent-b",
  "agent-c",
  "agent-d",
  "agent-e",
  "agent-f",
];

test("releases the transcript of an agent evicted from the selective hot set", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    const membership = await world.nextMembership();
    membership.succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }

  // The sixth agent pushed the first out of the five-agent hot set, and only the acknowledged
  // membership can say so.
  expect(world.released).toEqual(["agent-a"]);
  expect(world.releaseAttempts).toEqual(["agent-a"]);
});

test("an agent released on eviction is prepared again when it returns", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    const membership = await world.nextMembership();
    membership.succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }
  expect(world.released).toEqual(["agent-a"]);

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const catchUp = await world.nextFetch("agent-a");
  catchUp.respond({ hasNewer: false });

  expect(membership.agentIds).toEqual(["agent-a", "agent-c", "agent-d", "agent-e", "agent-f"]);
  expect(world.cacheRequests.filter((agentId) => agentId === "agent-a")).toHaveLength(2);
});

test("agents visible in panes are never released", async () => {
  const world = new TimelineWorld();
  const visible = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e", "agent-f"];
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", visible);
  const membership = await world.nextMembership();
  membership.succeed();
  const catchUps = await Promise.all(visible.map((agentId) => world.nextFetch(agentId)));
  for (const catchUp of catchUps) catchUp.respond({ hasNewer: false });
  expect(world.releaseAttempts).toEqual([]);

  world.sync.replaceVisibleAgentIds("workspace", visible.slice(0, 5));
  const eviction = await world.nextMembership();
  eviction.succeed();

  expect(eviction.agentIds).toEqual(visible.slice(0, 5));
  await vi.waitFor(() => expect(world.released).toEqual(["agent-f"]));
});

test("legacy delivery never releases a transcript", async () => {
  const world = new TimelineWorld();
  world.sync.setDeliveryMode("legacy");
  world.sync.setConnected(true);
  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }

  expect(world.releaseAttempts).toEqual([]);
});

test("backgrounding retains transcripts until the app returns", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS.slice(0, 5)) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    const membership = await world.nextMembership();
    membership.succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }

  world.sync.setActive(false);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-f"]);
  expect(world.releaseAttempts).toEqual([]);

  world.sync.setActive(true);
  const membership = await world.nextMembership();
  membership.succeed();
  const catchUp = await world.nextFetch("agent-f");
  catchUp.respond({ hasNewer: false });

  await vi.waitFor(() => expect(world.released).toEqual(["agent-a"]));
});

test("disconnect retains transcripts and releases after the reconnect acknowledgement", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS.slice(0, 5)) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    const membership = await world.nextMembership();
    membership.succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }

  world.sync.setConnected(false);
  world.expectNoPendingMembership();
  expect(world.releaseAttempts).toEqual([]);

  world.sync.setConnected(true);
  const restored = await world.nextMembership();
  restored.succeed();

  expect(restored.agentIds).toEqual(["agent-e"]);
  await vi.waitFor(() =>
    expect(world.released).toEqual(["agent-a", "agent-b", "agent-c", "agent-d"]),
  );
});

test("defers a release while its fetch is in flight and retries once it settles", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const agentAMembership = await world.nextMembership();
  agentAMembership.succeed();
  const agentAFetch = await world.nextFetch("agent-a");

  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS.slice(1)) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    const membership = await world.nextMembership();
    membership.succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }
  expect(world.releaseAttempts).toEqual([]);

  agentAFetch.respond({ hasNewer: false });

  await vi.waitFor(() => expect(world.released).toEqual(["agent-a"]));
});

test("defers a release until every superseded fetch for the agent settles", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const initialCatchUp = await world.nextFetch("agent-a");
  initialCatchUp.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));

  // A second recovery supersedes the first: both fetches are sync-owned and still in flight.
  world.sync.recoverGap("agent-a", { epoch: "epoch-agent-a", endSeq: 10 });
  const supersededFetch = await world.nextFetch("agent-a");
  expect(supersededFetch.request).toEqual({
    direction: "after",
    cursor: { epoch: "epoch-agent-a", seq: 10 },
    limit: 40,
    projection: "projected",
  });
  world.sync.recoverGap("agent-a", { epoch: "epoch-agent-a", endSeq: 20 });
  const supersedingFetch = await world.nextFetch("agent-a");
  expect(supersedingFetch.request).toEqual({
    direction: "after",
    cursor: { epoch: "epoch-agent-a", seq: 20 },
    limit: 40,
    projection: "projected",
  });

  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS.slice(1)) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    const evictionMembership = await world.nextMembership();
    evictionMembership.succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }
  expect(world.releaseAttempts).toEqual([]);

  supersededFetch.respond({ hasNewer: false });
  // Drain the settle path: the superseded fetch's `finally` and the abandoned catch-up
  // continuation both run, so an unchanged release log is real evidence and not just ordering.
  await Promise.resolve();
  await Promise.resolve();
  expect(world.releaseAttempts).toEqual([]);

  supersedingFetch.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.released).toEqual(["agent-a"]));
});

test("retries a refused release at the next settlement", async () => {
  const world = new TimelineWorld();
  world.blockedReleases.add("agent-a");
  world.sync.setConnected(true);
  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    const membership = await world.nextMembership();
    membership.succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }
  expect(world.releaseAttempts).toContain("agent-a");
  expect(world.releaseAttempts.every((agentId) => agentId === "agent-a")).toBe(true);
  expect(world.released).toEqual([]);

  world.blockedReleases.delete("agent-a");
  world.sync.replaceVisibleAgentIds("workspace", ["agent-g"]);
  const membership = await world.nextMembership();
  membership.succeed();
  const catchUp = await world.nextFetch("agent-g");
  catchUp.respond({ hasNewer: false });

  await vi.waitFor(() => expect(world.released).toContain("agent-a"));
  expect(world.released).not.toContain("agent-f");
});

test("a deferred release candidate survives a delivery-mode round trip", async () => {
  const world = new TimelineWorld();
  world.blockedReleases.add("agent-a");
  world.sync.setConnected(true);
  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    (await world.nextMembership()).succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }
  // The sixth visible agent pushed the first one out of the five-agent hot set. Its release was
  // attempted and refused, so it is a deferred candidate with its transcript still loaded.
  expect(world.releaseAttempts).toEqual(["agent-a"]);
  expect(world.released).toEqual([]);

  // The transition out releases nothing — legacy delivery cannot sweep — and the transition back
  // releases nothing either, because the entered policy's membership is not confirmed yet.
  // Neither may consume the candidate, or `agent-a` would keep its transcript for the session.
  world.sync.setDeliveryMode("legacy");
  world.sync.setDeliveryMode("selective");
  expect(world.releaseAttempts).toEqual(["agent-a"]);
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(false);

  world.blockedReleases.delete("agent-a");
  (await world.nextMembership()).succeed();
  // The retained candidate is what makes the acknowledgement sweep retry the refused release;
  // the other four hot agents the transition dropped are released by the same sweep.
  await vi.waitFor(() => expect(world.released).toContain("agent-a"));
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(true);
});

test("a released fence outlives a legacy interlude and is cleared only by wanting the agent again", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    (await world.nextMembership()).succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }
  expect(world.released).toEqual(["agent-a"]);
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(true);

  // Legacy delivery never reports a stale transcript, so the fence is unobservable while the
  // interlude runs — but the bookkeeping behind it must survive, because that interlude is
  // exactly when legacy hosts push frames for agents released under selective delivery.
  world.sync.setDeliveryMode("legacy");
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(false);

  world.sync.setDeliveryMode("selective");
  const membership = await world.nextMembership();
  // The transition publishes the visible set it knows, and the sixth agent is still visible.
  expect(membership.agentIds).toEqual(["agent-f"]);
  // Still fenced: the interlude neither retired the release nor re-wanted the agent.
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(true);
  expect(world.cacheRequests.filter((agentId) => agentId === "agent-a")).toHaveLength(1);

  // Wanting the agent again is what reloads the transcript, and the reload is what retires the
  // fence — never the mode change by itself.
  membership.succeed();
  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  const reacquire = await world.nextMembership();
  reacquire.succeed();
  const reload = await world.nextFetch("agent-a");
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(false);
  expect(world.cacheRequests.filter((agentId) => agentId === "agent-a")).toHaveLength(2);
  // Re-wanting is not a new eviction: the released transcript was never re-registered as a
  // candidate. The other four hot agents the transition dropped are evicted by this sweep, so
  // only a per-agent check is meaningful here.
  expect(world.releaseAttempts.filter((agentId) => agentId === "agent-a")).toEqual(["agent-a"]);
  reload.respond({ hasNewer: false });
  await vi.waitFor(() => expect(world.sync.getAgentTimelineStatus("agent-a")).toBe("ready"));
});

test("a legacy delivery that repopulated a released transcript is released again", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    (await world.nextMembership()).succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }
  expect(world.released).toEqual(["agent-a"]);

  // Only legacy delivery reports the transcript as unreleased, so the owner's admission points can
  // admit frames for it while the fence stands.
  world.sync.setDeliveryMode("legacy");
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(false);

  // Without this the repopulated arrays are unknown to the sweep: `agent-a` would have no loaded
  // cache and no candidate left, so it could never be evicted again.
  world.sync.noteTranscriptUpdate("agent-a");

  world.sync.setDeliveryMode("selective");
  (await world.nextMembership()).succeed();
  // The fence is intact, and the legacy repopulation is eligible for eviction again. `agent-a` is
  // released a second time, alongside the four hidden hot agents the transition dropped.
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(true);
  await vi.waitFor(() =>
    expect(world.releaseAttempts.filter((agentId) => agentId === "agent-a")).toHaveLength(2),
  );
  expect(world.released.filter((agentId) => agentId === "agent-a")).toHaveLength(2);
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(true);
});

test("backgrounding and an unchanged publication both keep a released fence", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) {
    world.sync.replaceVisibleAgentIds("workspace", [agentId]);
    (await world.nextMembership()).succeed();
    const catchUp = await world.nextFetch(agentId);
    catchUp.respond({ hasNewer: false });
  }
  // `agent-f` is the sixth agent and stays visible, so the released agent is never re-wanted.
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(true);

  world.sync.setActive(false);
  world.sync.setActive(true);
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(true);

  // An unchanged publication and a repeated non-empty one must both keep the fence: wanting the
  // released agent again is what would retire it.
  world.sync.replaceVisibleAgentIds("workspace", ["agent-f"]);
  world.sync.replaceVisibleAgentIds("workspace", ["agent-f"]);
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(true);

  world.sync.replaceVisibleAgentIds("workspace", ["agent-a"]);
  (await world.nextMembership()).succeed();
  expect(world.sync.isTranscriptReleased("agent-a")).toBe(false);
  const reload = await world.nextFetch("agent-a");
  expect(world.cacheRequests.filter((agentId) => agentId === "agent-a")).toHaveLength(2);
  reload.respond({ hasNewer: false });
});

test("a delivery-mode transition that drops hot agents keeps them releasable", async () => {
  const world = new TimelineWorld();
  world.sync.setConnected(true);
  const hot = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-f"];
  world.sync.replaceVisibleAgentIds("workspace", hot);
  (await world.nextMembership()).succeed();
  const initial = await Promise.all(hot.map((agentId) => world.nextFetch(agentId)));
  for (const fetch of initial) fetch.respond({ hasNewer: false });
  await vi.waitFor(() => {
    for (const agentId of hot) expect(world.sync.getAgentTimelineStatus(agentId)).toBe("ready");
  });
  expect(world.releaseAttempts).toEqual([]);

  // Narrowing the panes leaves `agent-f` desired as the most recently hidden agent, so it is
  // still hot and its transcript stays loaded.
  world.sync.replaceVisibleAgentIds("workspace", hot.slice(0, 4));
  expect(world.sync.getAgentTimelineStatus("agent-f")).toBe("ready");
  expect(world.releaseAttempts).toEqual([]);

  // Entering legacy delivery derives desired from the sources alone, so `agent-f` is dropped. The
  // transition cannot release anything — the entered policy is unconfirmed — but the dropped agent
  // must stay registered, or the sweep could never evict it.
  world.sync.setDeliveryMode("legacy");
  expect(world.releaseAttempts).toEqual([]);
  world.sync.setDeliveryMode("selective");
  (await world.nextMembership()).succeed();

  await vi.waitFor(() => expect(world.released).toEqual(["agent-f"]));
  expect(world.sync.isTranscriptReleased("agent-f")).toBe(true);
});

test("healthy selective subscription preserved through background retains history sync generation while reconnect invalidates and catches up", async () => {
  const serverId = "test-server";
  const agentId = "agent-a";
  useSessionStore.getState().initializeSession(serverId, null);

  const memberships: string[][] = [];
  const fetches: Array<{ agentId: string; request: ProjectedTimelineForwardFetchPlan }> = [];

  const replica = createTimelineReplica({
    serverId,
    storage: {
      readTimeline: async () => undefined,
      commitTimeline: () => undefined,
    },
    prepareAgent: async () => undefined,
  });

  const owner = createViewedTimelineOwner({
    serverId,
    replica,
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    ports: {
      initialDeliveryMode: "selective",
      setSubscription: async (agentIds) => {
        memberships.push(agentIds);
      },
      readCursor: () => undefined,
      fetchPage: async (id, request) => {
        fetches.push({ agentId: id, request });
        return { hasNewer: false, endCursor: null };
      },
      fetchLatestTail: async (id) => {
        fetches.push({
          agentId: id,
          request: { direction: "tail", limit: 40, projection: "projected" },
        });
        return { hasNewer: false, endCursor: null };
      },
      reportError: () => undefined,
      schedule: () => () => undefined,
    },
  });

  try {
    owner.setConnected(true);
    owner.replaceVisibleAgentIds("workspace", [agentId]);

    await vi.waitFor(() => expect(memberships).toEqual([[agentId]]));
    await vi.waitFor(() => expect(fetches.length).toBe(1));
    expect(fetches[0].agentId).toBe(agentId);

    owner.applyTimelineResponse({
      requestId: "init-tail",
      agentId,
      agent: null,
      direction: "tail",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 1, nextSeq: 2 },
      startCursor: { epoch: "epoch-1", seq: 1 },
      endCursor: { epoch: "epoch-1", seq: 1 },
      entries: [
        {
          provider: "codex",
          item: { type: "user_message", text: "Initial canonical message" },
          timestamp: "2026-09-09T10:00:00.000Z",
          seqStart: 1,
          seqEnd: 1,
          sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
          collapsed: [],
        },
      ],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    });

    await vi.waitFor(() => expect(owner.getAgentTimelineStatus(agentId)).toBe("ready"));

    let session = useSessionStore.getState().sessions[serverId];
    expect(session?.historySyncGeneration).toBe(0);
    expect(session?.agentHistorySyncGeneration.get(agentId)).toBe(0);

    // Backgrounding preserves healthy selective subscription
    owner.setActive(false);

    // Canonical stream completion received while inactive
    const streamEvent: AgentStreamEventPayload = {
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "Streamed completion while backgrounded" },
    };
    owner.enqueueStreamEvent(agentId, {
      event: streamEvent,
      seq: 2,
      epoch: "epoch-1",
      timestamp: new Date("2026-09-09T10:01:00.000Z"),
    });

    const completionEvent: AgentStreamEventPayload = {
      type: "turn_completed",
      provider: "codex",
    };
    owner.enqueueStreamEvent(agentId, {
      event: completionEvent,
      seq: 3,
      epoch: "epoch-1",
      timestamp: new Date("2026-09-09T10:01:01.000Z"),
    });
    owner.flushStreamAgent(agentId);

    // Foreground return preserves readiness without artificial generation invalidation
    owner.setActive(true);

    // Foreground returns the agent to readiness, but a selective stream never closed, so the
    // surviving subscription owes an authoritative tail for the inactivity it could not observe.
    await vi.waitFor(() => expect(fetches.length).toBe(2));
    expect(fetches[1]).toEqual({
      agentId,
      request: { direction: "tail", limit: 40, projection: "projected" },
    });
    await vi.waitFor(() => expect(owner.getAgentTimelineStatus(agentId)).toBe("ready"));
    expect(memberships).toHaveLength(1);

    // Rendered store items retained across backgrounding
    const timeline = selectAgentTimelineState(
      useSessionStore.getState().sessions[serverId],
      agentId,
    );
    expect(timeline.status).toBe("synced");
    if (timeline.status !== "synced") {
      throw new Error("Expected timeline to be synced");
    }
    expect(timeline.items).toEqual([
      expect.objectContaining({ kind: "user_message", text: "Initial canonical message" }),
      expect.objectContaining({
        kind: "assistant_message",
        text: "Streamed completion while backgrounded",
      }),
    ]);

    session = useSessionStore.getState().sessions[serverId];
    expect(session?.historySyncGeneration).toBe(0);
    expect(session?.agentHistorySyncGeneration.get(agentId)).toBe(0);

    // Real reconnect marks history generation invalidated on online transition
    owner.setConnected(false);
    useSessionStore.getState().bumpHistorySyncGeneration(serverId);
    owner.setConnected(true);

    session = useSessionStore.getState().sessions[serverId];
    expect(session?.historySyncGeneration).toBe(1);
    expect(session?.agentHistorySyncGeneration.get(agentId)).toBe(0);

    await vi.waitFor(() => expect(memberships.length).toBe(2));
    expect(memberships[1]).toEqual([agentId]);
    await vi.waitFor(() => expect(fetches.length).toBe(3));
    expect(fetches[2]).toEqual({
      agentId,
      request: { direction: "tail", limit: 40, projection: "projected" },
    });

    owner.applyTimelineResponse({
      requestId: "reconnect-tail",
      agentId,
      agent: null,
      direction: "tail",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
      startCursor: { epoch: "epoch-1", seq: 1 },
      endCursor: { epoch: "epoch-1", seq: 2 },
      entries: [
        {
          provider: "codex",
          item: { type: "user_message", text: "Initial canonical message" },
          timestamp: "2026-09-09T10:00:00.000Z",
          seqStart: 1,
          seqEnd: 1,
          sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
          collapsed: [],
        },
        {
          provider: "codex",
          item: { type: "assistant_message", text: "Caught up canonical message" },
          timestamp: "2026-09-09T10:02:00.000Z",
          seqStart: 2,
          seqEnd: 2,
          sourceSeqRanges: [{ startSeq: 2, endSeq: 2 }],
          collapsed: [],
        },
      ],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    });

    await vi.waitFor(() => expect(owner.getAgentTimelineStatus(agentId)).toBe("ready"));

    session = useSessionStore.getState().sessions[serverId];
    expect(session?.historySyncGeneration).toBe(1);
    expect(session?.agentHistorySyncGeneration.get(agentId)).toBe(1);
  } finally {
    owner.dispose();
    useSessionStore.getState().clearSession(serverId);
  }
});
