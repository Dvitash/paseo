import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import { ReplicaCache } from "@/runtime/replica-cache";
import {
  createSqliteReplicaRowStore,
  type ReplicaSqliteConnection,
  type SqliteValue,
} from "@/runtime/replica-cache/row-store-sqlite";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { CachedTimeline } from "@/runtime/replica-cache";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import { useDraftStore } from "@/stores/draft-store";
import type { AttachmentMetadata } from "@/attachments/types";
import { createUserMessage, type StreamItem } from "@/types/stream";
import type { ProjectedTimelineForwardFetchPlan } from "./timeline-sync-plan";
import {
  createTimelineReplica,
  createViewedTimelineOwner,
  type TimelinePageResult,
  type TimelineReplica,
  type TimelineReplicaStorage,
  type TimelineResponsePayload,
  type ViewedTimelineOwner,
} from "./viewed-timeline-sync";

const SERVER_ID = "timeline-replica-host";
const AGENT_ID = "agent-1";

function item(id: string, text: string, seq: number): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date("2026-08-26T10:00:00.000Z"),
    timelineCursor: { epoch: "epoch-1", seq },
  };
}

function cachedTimeline(): CachedTimeline {
  return {
    agentId: AGENT_ID,
    items: [item("cached", "cached", 4)],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
    hasOlder: true,
  };
}

// A commit carries the store-owned tail and head separately; persistence joins them into the row.
function materializeTimeline(commit: CachedTimeline): CachedTimeline {
  const { agentId, items, head, range, hasOlder } = commit;
  return { agentId, items: [...items, ...(head ?? [])], range, hasOlder };
}

interface TrackedTimelineItems {
  items: StreamItem[];
  reads(): number;
}

function trackedItems(text: string, count: number): TrackedTimelineItems {
  const items: StreamItem[] = [];
  let reads = 0;
  for (let index = 0; index < count; index += 1) {
    Object.defineProperty(items, index, {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return item(`${text}-${index}`, `${text}-${index}`, index);
      },
    });
  }
  return { items, reads: () => reads };
}

function createOwner(storage: TimelineReplicaStorage): ViewedTimelineOwner {
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage,
    prepareAgent: async () => undefined,
  });
  return createViewedTimelineOwner({
    serverId: SERVER_ID,
    replica,
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    ports: {
      initialDeliveryMode: "legacy",
      setSubscription: async () => undefined,
      readCursor: () => undefined,
      fetchPage: async () => ({ hasNewer: false, endCursor: null }),
      fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
      reportError: () => undefined,
      schedule: () => () => undefined,
    },
  });
}

function applySynced(agentId: string, seq: number): void {
  useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, agentId, {
    items: [item(`network-${agentId}`, "network", seq)],
    head: [],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: seq },
    older: "available",
    newer: false,
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
}

afterEach(() => useSessionStore.getState().clearSession(SERVER_ID));

describe("viewed timeline persistence", () => {
  it("shares an in-flight cache preparation with the viewed owner", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    let reads = 0;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        readTimeline: () => {
          reads += 1;
          return read;
        },
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const routePreparation = replica.prepare(AGENT_ID);
    const ownerPreparation = replica.prepare(AGENT_ID);
    release(cachedTimeline());
    await Promise.all([routePreparation, ownerPreparation]);

    expect(reads).toBe(1);
    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
  });

  it("paints cached history without claiming authoritative synchronization", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const owner = createOwner({
      readTimeline: async () => cachedTimeline(),
      commitTimeline: () => undefined,
    });

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toEqual({ status: "painted", items: cachedTimeline().items });
    owner.dispose();
  });

  it("reconciles an overlapping projected message against its cached cursor", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const partial = "```mermaid\nflowchart LR\n  Start --> Mid";
    const complete = `${partial}dle\n  Middle --> Done\n\`\`\``;
    const owner = createOwner({
      readTimeline: async () => ({
        agentId: AGENT_ID,
        items: [item("cached", partial, 4)],
        range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
        hasOlder: false,
      }),
      commitTimeline: () => undefined,
    });

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "painted" });

    owner.applyTimelineResponse({
      requestId: "page-after-cache",
      agentId: AGENT_ID,
      agent: null,
      direction: "after",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 5, nextSeq: 6 },
      startCursor: { epoch: "epoch-1", seq: 5 },
      endCursor: { epoch: "epoch-1", seq: 5 },
      entries: [
        {
          provider: "mock",
          item: { type: "assistant_message", text: complete },
          timestamp: "2026-08-26T10:00:00.000Z",
          seqStart: 2,
          seqEnd: 5,
          sourceSeqRanges: [{ startSeq: 2, endSeq: 5 }],
          collapsed: ["assistant_merge"],
        },
      ],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    });

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toMatchObject([{ kind: "assistant_message", text: complete }]);
    owner.dispose();
  });

  it("reopens painted live mutations without persisting authoritative coverage", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let durable: CachedTimeline | undefined = cachedTimeline();
    let pending: CachedTimeline | undefined;
    const storage: TimelineReplicaStorage = {
      readTimeline: async () => durable,
      commitTimeline: (_serverId, _agentId, timeline) => {
        pending = timeline;
      },
    };
    const first = createOwner(storage);
    first.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "painted" });

    first.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "live", messageId: "live" },
      } as AgentStreamEventPayload,
      seq: 5,
      epoch: "epoch-1",
      timestamp: new Date("2026-08-26T10:00:01.000Z"),
    });
    first.flushStreamAgent(AGENT_ID);

    expect(pending).toMatchObject({ range: null, hasOlder: false });
    const committed = pending ? materializeTimeline(pending) : undefined;
    expect(committed?.items.map((entry) => entry.id)).toEqual(["cached", expect.any(String)]);
    durable = committed;
    first.dispose();
    useSessionStore.getState().clearSession(SERVER_ID);
    useSessionStore.getState().initializeSession(SERVER_ID, null);

    const reopened = createOwner(storage);
    reopened.replaceVisibleAgentIds("test", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({
        status: "painted",
        items: [
          expect.objectContaining({ id: "cached" }),
          expect.objectContaining({ text: "live" }),
        ],
      });
    reopened.dispose();
  });

  it("does not let a late cache read overwrite newer network state", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const owner = createOwner({
      readTimeline: () => read,
      commitTimeline: () => undefined,
    });

    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    applySynced(AGENT_ID, 8);
    release(cachedTimeline());

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toMatchObject({ status: "synced", range: { endSeq: 8 } });
    owner.dispose();
  });

  it("paints cached rows without replacing a live head that arrives during preparation", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const preparation = replica.prepare(AGENT_ID);
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      head: [item("live", "live", 5)],
    });
    release(cachedTimeline());
    await preparation;

    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toEqual({ status: "painted", items: cachedTimeline().items });
    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamHead.get(AGENT_ID)).toEqual([
      item("live", "live", 5),
    ]);
  });

  it("reconciles a live head that overlaps the cached canonical timeline", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const preparation = replica.prepare(AGENT_ID);
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      head: [item("cached", "cached", 4), item("live", "live", 5)],
    });
    release(cachedTimeline());
    await preparation;

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toEqual([item("cached", "cached", 4), item("live", "live", 5)]);
    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
  });

  it("reconciles cached rows with a non-authoritative timeline painted during preparation", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    let release!: (value: CachedTimeline) => void;
    const read = new Promise<CachedTimeline>((resolve) => {
      release = resolve;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        readTimeline: () => read,
        commitTimeline: () => undefined,
      },
      prepareAgent: async () => undefined,
    });

    const preparation = replica.prepare(AGENT_ID);
    useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, AGENT_ID, {
      items: [item("live", "live", 5)],
      head: [],
      range: null,
      older: "none",
      newer: false,
      synchronized: false,
      acknowledgedClientMessageIds: [],
    });
    release(cachedTimeline());
    await preparation;

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect([
      ...(session?.agentStreamTail.get(AGENT_ID) ?? []),
      ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
    ]).toEqual([item("cached", "cached", 4), item("live", "live", 5)]);
    expect(replica.readCursor(AGENT_ID)).toEqual({ epoch: "epoch-1", endSeq: 4 });
  });

  it("persists accepted live stream commits through the owner", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    applySynced(AGENT_ID, 8);
    const commits: CachedTimeline[] = [];
    const owner = createOwner({
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, _agentId, timeline) => commits.push(timeline),
    });
    owner.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "live", messageId: "live" },
      } as AgentStreamEventPayload,
      seq: 9,
      epoch: "epoch-1",
      timestamp: new Date("2026-08-26T10:00:01.000Z"),
    });
    owner.flushStreamAgent(AGENT_ID);

    const commit = commits.at(-1);
    if (!commit) throw new Error("timeline commit was not recorded");
    expect(materializeTimeline(commit).items.at(-1)).toMatchObject({ text: "live" });
    expect(commit.range?.endSeq).toBe(9);
    owner.dispose();
  });

  it("applies and persists authoritative pages inside the owner", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const keys: string[] = [];
    const owner = createOwner({
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, agentId) => keys.push(agentId),
    });

    owner.applyTimelineResponse({
      requestId: "page-1",
      agentId: AGENT_ID,
      agent: null,
      direction: "tail",
      projection: "projected",
      reset: false,
      epoch: "epoch-1",
      window: { minSeq: 1, maxSeq: 0, nextSeq: 1 },
      startCursor: null,
      endCursor: null,
      entries: [],
      error: null,
      hasNewer: false,
      hasOlder: false,
      staleCursor: false,
      gap: false,
    });

    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toMatchObject({ status: "synced" });
    expect(keys).toEqual([AGENT_ID]);
    owner.dispose();
  });

  it("persists demanded agents independently", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const keys: string[] = [];
    const owner = createOwner({
      readTimeline: async () => undefined,
      commitTimeline: (_serverId, agentId) => keys.push(agentId),
    });

    applySynced(AGENT_ID, 8);
    applySynced("agent-2", 3);
    for (const [agentId, seq] of [
      [AGENT_ID, 9],
      ["agent-2", 4],
    ] as const) {
      owner.enqueueStreamEvent(agentId, {
        event: {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: agentId, messageId: `live-${agentId}` },
        } as AgentStreamEventPayload,
        seq,
        epoch: "epoch-1",
        timestamp: new Date("2026-08-26T10:00:01.000Z"),
      });
      owner.flushStreamAgent(agentId);
    }

    expect(keys).toEqual([AGENT_ID, "agent-2"]);
    owner.dispose();
  });

  it("keeps repeated stream commits by reference without copying history", () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const commits: CachedTimeline[] = [];
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: {
        readTimeline: async () => undefined,
        commitTimeline: (_serverId, _agentId, timeline) => commits.push(timeline),
      },
      prepareAgent: async () => undefined,
    });
    const tail = trackedItems("tail", 200);
    const head = trackedItems("head", 2);
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      tail: tail.items,
      head: head.items,
    });

    replica.timelineUpdated(AGENT_ID);
    const readsBeforeCommits = { tail: tail.reads(), head: head.reads() };
    replica.timelineUpdated(AGENT_ID);
    replica.timelineUpdated(AGENT_ID);

    expect(commits).toHaveLength(3);
    const commit = commits.at(-1);
    expect(commit?.agentId).toBe(AGENT_ID);
    expect(commit?.items).toBe(tail.items);
    expect(commit?.head).toBe(head.items);
    expect(commit?.range).toBeNull();
    expect(commit?.hasOlder).toBe(false);
    expect({ tail: tail.reads(), head: head.reads() }).toEqual(readsBeforeCommits);
  });
});

function createSqliteCache() {
  const database = new DatabaseSync(":memory:");
  let beforeRead = async () => {};
  const connection: ReplicaSqliteConnection = {
    async exec(sql) {
      database.exec(sql);
    },
    async run(sql, params = []) {
      database.prepare(sql).run(...params);
    },
    async all<Row>(sql: string, params: readonly SqliteValue[] = []) {
      const rows = database.prepare(sql).all(...params) as Row[];
      if (sql.includes("FROM rows") && sql.includes("WHERE")) await beforeRead();
      return rows;
    },
    async transaction(operation) {
      database.exec("BEGIN IMMEDIATE");
      try {
        await operation(connection);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const storage = createSqliteReplicaRowStore({ open: async () => connection }, 1);
  const cache = new ReplicaCache(storage, { clearLegacyCache: async () => {} });
  return {
    cache,
    database,
    holdRead: (operation: () => Promise<void>) => {
      beforeRead = operation;
    },
  };
}

describe("SQLite baseline restoration", () => {
  it.each([false, true])(
    "keeps display-only cached history under a live event (synced=%s)",
    async (synced) => {
      useSessionStore.getState().initializeSession(SERVER_ID, null);
      const { cache, database, holdRead } = createSqliteCache();
      cache.setHosts([SERVER_ID]);
      cache.commitTimeline(SERVER_ID, AGENT_ID, {
        ...cachedTimeline(),
        items: [item("earlier", "earlier", 1), ...cachedTimeline().items],
        range: null,
      });
      await cache.flush();
      holdRead(async () => {
        if (synced) applySynced(AGENT_ID, 8);
        else
          useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
            head: [item("cached", "cached", 4), item("live", "live", 5)],
          });
      });
      const replica = createTimelineReplica({
        serverId: SERVER_ID,
        storage: cache,
        prepareAgent: async () => {},
      });
      await replica.prepare(AGENT_ID);
      const session = useSessionStore.getState().sessions[SERVER_ID];
      const timeline = selectAgentTimelineState(session, AGENT_ID);
      expect(timeline.status).toBe(synced ? "synced" : "painted");
      expect([
        ...(timeline.status === "cold" ? [] : timeline.items),
        ...(session?.agentStreamHead.get(AGENT_ID) ?? []),
      ]).toEqual(
        synced
          ? [item(`network-${AGENT_ID}`, "network", 8)]
          : [item("earlier", "earlier", 1), item("cached", "cached", 4), item("live", "live", 5)],
      );
      expect(replica.readCursor(AGENT_ID)).toBeUndefined();
      database.close();
    },
  );

  it("starts the timeline disk read while agent preparation is pending", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { cache, database, holdRead } = createSqliteCache();
    cache.setHosts([SERVER_ID]);
    cache.commitTimeline(SERVER_ID, AGENT_ID, cachedTimeline());
    await cache.flush();
    let readStarted = false;
    let release!: () => void;
    const agentReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    holdRead(async () => {
      readStarted = true;
    });
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: cache,
      prepareAgent: () => agentReady,
    });
    const preparation = replica.prepare(AGENT_ID);
    try {
      await expect.poll(() => readStarted, { timeout: 500 }).toBe(true);
    } finally {
      release();
      await preparation;
      database.close();
    }
  });

  it("persists the displayed tail before the live head", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { cache, database } = createSqliteCache();
    cache.setHosts([SERVER_ID]);
    const replica = createTimelineReplica({
      serverId: SERVER_ID,
      storage: cache,
      prepareAgent: async () => {},
    });
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      tail: [item("tail", "tail", 1)],
      head: [item("head", "head", 2)],
    });

    replica.timelineUpdated(AGENT_ID);
    await cache.flush();

    expect(
      (await cache.readTimeline(SERVER_ID, AGENT_ID))?.items
        .filter((entry): entry is Extract<StreamItem, { kind: "assistant_message" }> => {
          return entry.kind === "assistant_message";
        })
        .map((entry) => entry.text),
    ).toEqual(["tail", "head"]);
    database.close();
  });
});

interface SelectiveOwnerHarness {
  owner: ViewedTimelineOwner;
  replica: TimelineReplica;
  fetchRequests: Array<{ agentId: string; request: ProjectedTimelineForwardFetchPlan }>;
}

function createSelectiveOwner(storage: TimelineReplicaStorage): SelectiveOwnerHarness {
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage,
    prepareAgent: async () => undefined,
  });
  const fetchRequests: SelectiveOwnerHarness["fetchRequests"] = [];
  const owner = createViewedTimelineOwner({
    serverId: SERVER_ID,
    replica,
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    ports: {
      initialDeliveryMode: "selective",
      setSubscription: async () => undefined,
      readCursor: () => undefined,
      fetchPage: async (agentId, request) => {
        fetchRequests.push({ agentId, request });
        return { hasNewer: false, endCursor: null };
      },
      fetchLatestTail: async (): Promise<TimelinePageResult> => ({
        hasNewer: false,
        endCursor: null,
      }),
      reportError: () => undefined,
      schedule: () => () => undefined,
    },
  });
  return { owner, replica, fetchRequests };
}

function createMemoryTimelineStorage(): {
  storage: TimelineReplicaStorage;
  rows: Map<string, CachedTimeline>;
  commits: string[];
} {
  const rows = new Map<string, CachedTimeline>();
  const commits: string[] = [];
  return {
    rows,
    commits,
    storage: {
      readTimeline: async (_serverId, agentId) => rows.get(agentId),
      commitTimeline: (_serverId, agentId, timeline) => {
        commits.push(agentId);
        rows.set(agentId, materializeTimeline(timeline));
      },
    },
  };
}

function applySyncedTimeline(
  agentId: string,
  items: StreamItem[],
  range: { startSeq: number; endSeq: number },
): void {
  useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, agentId, {
    items,
    head: [],
    range: { epoch: "epoch-1", startSeq: range.startSeq, endSeq: range.endSeq },
    older: "available",
    newer: false,
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
}

function timelinePage(input: {
  requestId: string;
  agentId: string;
  direction: "tail" | "before" | "after";
  startSeq: number;
  endSeq: number;
  text: string;
  hasOlder?: boolean;
  kind?: "assistant_message" | "user_message";
}): TimelineResponsePayload {
  const { requestId, agentId, direction, startSeq, endSeq, text } = input;
  const timelineEntry =
    input.kind === "user_message"
      ? { type: "user_message" as const, text, messageId: requestId }
      : { type: "assistant_message" as const, text };
  return {
    requestId,
    agentId,
    agent: null,
    direction,
    projection: "projected",
    reset: false,
    epoch: "epoch-1",
    window: { minSeq: startSeq, maxSeq: endSeq, nextSeq: endSeq + 1 },
    startCursor: { epoch: "epoch-1", seq: startSeq },
    endCursor: { epoch: "epoch-1", seq: endSeq },
    entries: [
      {
        provider: "mock",
        item: timelineEntry,
        timestamp: "2026-08-26T10:00:00.000Z",
        seqStart: startSeq,
        seqEnd: endSeq,
        sourceSeqRanges: [{ startSeq, endSeq }],
        collapsed: [],
      },
    ],
    error: null,
    hasNewer: false,
    hasOlder: input.hasOlder ?? true,
    staleCursor: false,
    gap: false,
  };
}

function userRowWithAttachment(seq: number): StreamItem {
  const attachment: AttachmentMetadata = {
    id: "attachment-1",
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: "blob-1",
    createdAt: 1,
  };
  return {
    kind: "user_message",
    id: "attached",
    clientMessageId: "attached",
    messageId: "attached",
    timelineCursor: { epoch: "epoch-1", seq },
    text: "with a local attachment",
    timestamp: new Date("2026-08-26T10:00:00.000Z"),
    images: [attachment],
  };
}

function orchestratorToolCall(seq: number): StreamItem {
  return {
    kind: "tool_call",
    id: "orchestrator-tool",
    timelineCursor: { epoch: "epoch-1", seq },
    timestamp: new Date("2026-08-26T10:00:00.000Z"),
    payload: {
      source: "orchestrator",
      data: { toolCallId: "call-1", toolName: "delegate", arguments: {}, status: "completed" },
    },
  };
}

const RELEASE_WORKLOAD_AGENT_IDS = ["agent-2", "agent-3", "agent-4", "agent-5", "agent-6"];

function visitAgent(owner: ViewedTimelineOwner, agentId: string, endSeq: number): void {
  owner.replaceVisibleAgentIds("panes", [agentId]);
  applySyncedTimeline(agentId, [item(`network-${agentId}`, "network", endSeq)], {
    startSeq: 1,
    endSeq,
  });
}

describe("cold transcript release", () => {
  it("releases an evicted transcript and keeps its durable snapshot and non-transcript state", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { storage, rows } = createMemoryTimelineStorage();
    const { owner } = createSelectiveOwner(storage);
    owner.setConnected(true);
    owner.replaceVisibleAgentIds("panes", [AGENT_ID]);
    applySyncedTimeline(AGENT_ID, [item("cold", "cold", 8)], { startSeq: 1, endSeq: 8 });
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      taskSnapshot: [{ text: "ship it", completed: false }],
    });
    useSessionStore
      .getState()
      .setQueuedMessages(
        SERVER_ID,
        new Map([[AGENT_ID, [{ id: "queued-1", text: "queued", attachments: [] }]]]),
      );
    const draftKey = `agent:${SERVER_ID}:${AGENT_ID}`;
    useDraftStore
      .getState()
      .saveDraftInput({ draftKey, draft: { text: "draft", attachments: [] } });
    const lastActivity = new Date("2026-08-26T10:00:00.000Z");
    useSessionStore.getState().setAgentLastActivityBatch(new Map([[AGENT_ID, lastActivity]]));

    for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) visitAgent(owner, agentId, 8);

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toEqual({ status: "cold" });

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(session?.agentStreamTail.has(AGENT_ID)).toBe(false);
    expect(session?.agentStreamHead.has(AGENT_ID)).toBe(false);
    expect(session?.agentTimelineCursor.has(AGENT_ID)).toBe(false);
    expect(session?.agentAuthoritativeHistoryApplied.has(AGENT_ID)).toBe(false);
    // Everything else keyed by the agent survives: a cold transcript is not a deleted agent.
    expect(session?.agentTasks.get(AGENT_ID)).toEqual([{ text: "ship it", completed: false }]);
    expect(session?.queuedMessages.get(AGENT_ID)).toEqual([
      { id: "queued-1", text: "queued", attachments: [] },
    ]);
    expect(useSessionStore.getState().agentLastActivity.get(AGENT_ID)).toEqual(lastActivity);
    expect(useDraftStore.getState().getDraftInput(draftKey)).toEqual({
      text: "draft",
      attachments: [],
    });
    // The fifth and sixth agents are the hot set; the released agent keeps a bounded snapshot.
    expect(session?.agentStreamTail.has("agent-6")).toBe(true);
    expect(rows.get(AGENT_ID)).toEqual({
      agentId: AGENT_ID,
      items: [item("cold", "cold", 8)],
      range: { epoch: "epoch-1", startSeq: 1, endSeq: 8 },
      hasOlder: true,
    });

    // True deletion still clears what a cold release keeps.
    useSessionStore.getState().removeAgentTransientState(SERVER_ID, AGENT_ID);
    const afterDeletion = useSessionStore.getState().sessions[SERVER_ID];
    expect(afterDeletion?.agentTasks.has(AGENT_ID)).toBe(false);
    expect(afterDeletion?.queuedMessages.has(AGENT_ID)).toBe(false);
    expect(useSessionStore.getState().agentLastActivity.has(AGENT_ID)).toBe(false);
    useDraftStore.getState().clearDraftInput({ draftKey });
    owner.dispose();
  });

  it("keeps transcripts holding local prompts and presentation the cache cannot reproduce", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { storage, rows } = createMemoryTimelineStorage();
    const { owner } = createSelectiveOwner(storage);
    owner.setConnected(true);

    owner.replaceVisibleAgentIds("panes", ["agent-prompt"]);
    applySyncedTimeline("agent-prompt", [item("canonical", "canonical", 4)], {
      startSeq: 1,
      endSeq: 4,
    });
    useSessionStore.getState().beginAgentMessageSubmission(
      SERVER_ID,
      "agent-prompt",
      createUserMessage({
        clientMessageId: "client-1",
        text: "unresolved prompt",
        timestamp: new Date("2026-08-26T10:00:00.000Z"),
      }),
    );

    owner.replaceVisibleAgentIds("panes", ["agent-attachment"]);
    applySyncedTimeline(
      "agent-attachment",
      [item("canonical", "canonical", 4), userRowWithAttachment(5)],
      { startSeq: 1, endSeq: 5 },
    );

    owner.replaceVisibleAgentIds("panes", ["agent-orchestrator"]);
    applySyncedTimeline(
      "agent-orchestrator",
      [item("canonical", "canonical", 4), orchestratorToolCall(5)],
      { startSeq: 1, endSeq: 5 },
    );

    owner.replaceVisibleAgentIds("panes", ["agent-live"]);
    applySyncedTimeline("agent-live", [item("canonical", "canonical", 4)], {
      startSeq: 1,
      endSeq: 4,
    });
    useSessionStore.getState().setAgentStreamState(SERVER_ID, "agent-live", {
      head: [
        {
          kind: "thought",
          id: "live-thought",
          text: "still arriving",
          status: "loading",
          timestamp: new Date("2026-08-26T10:00:00.000Z"),
        },
      ],
    });

    owner.replaceVisibleAgentIds("panes", ["agent-cold"]);
    applySyncedTimeline("agent-cold", [item("cold", "cold", 8)], { startSeq: 1, endSeq: 8 });

    for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) visitAgent(owner, agentId, 8);

    // The control agent proves the eviction sweep ran; the protected ones hold their rows.
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], "agent-cold"),
      )
      .toEqual({ status: "cold" });

    const session = useSessionStore.getState().sessions[SERVER_ID];
    for (const agentId of [
      "agent-prompt",
      "agent-attachment",
      "agent-orchestrator",
      "agent-live",
    ]) {
      expect(session?.agentStreamTail.has(agentId)).toBe(true);
      expect(rows.has(agentId)).toBe(false);
    }
    expect(session?.agentStreamTail.get("agent-prompt")).toHaveLength(2);
    expect(session?.messageSubmissions.get("agent-prompt")).toHaveLength(1);
    owner.dispose();
  });

  it("releases a transcript whose live head rows are positioned", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { storage, rows } = createMemoryTimelineStorage();
    const { owner } = createSelectiveOwner(storage);
    owner.setConnected(true);
    owner.replaceVisibleAgentIds("panes", [AGENT_ID]);
    applySyncedTimeline(AGENT_ID, [item("canonical", "canonical", 4)], {
      startSeq: 1,
      endSeq: 5,
    });
    useSessionStore.getState().setAgentStreamState(SERVER_ID, AGENT_ID, {
      head: [item("live", "live", 5)],
    });

    for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) visitAgent(owner, agentId, 8);

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toEqual({ status: "cold" });
    expect(rows.get(AGENT_ID)?.items.map((entry) => entry.id)).toEqual(["canonical", "live"]);
    expect(rows.get(AGENT_ID)?.range).toEqual({ epoch: "epoch-1", startSeq: 1, endSeq: 5 });
    owner.dispose();
  });

  it("fences a late page and rebuilds the transcript from cache on return", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { storage, rows, commits } = createMemoryTimelineStorage();
    const { owner, fetchRequests } = createSelectiveOwner(storage);
    owner.setConnected(true);
    owner.replaceVisibleAgentIds("panes", [AGENT_ID]);
    applySyncedTimeline(AGENT_ID, [item("cached", "cached", 8)], { startSeq: 5, endSeq: 8 });

    for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) visitAgent(owner, agentId, 8);

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toEqual({ status: "cold" });
    const commitsAfterRelease = commits.filter((agentId) => agentId === AGENT_ID).length;

    // A page issued before the release must not resurrect the evicted transcript.
    owner.applyTimelineResponse(
      timelinePage({
        requestId: "stale-tail",
        agentId: AGENT_ID,
        direction: "tail",
        startSeq: 1,
        endSeq: 8,
        text: "stale",
      }),
    );
    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toEqual({ status: "cold" });
    expect(commits.filter((agentId) => agentId === AGENT_ID)).toHaveLength(commitsAfterRelease);

    // Returning re-paints the cached display, then resumes from the cached coverage.
    owner.replaceVisibleAgentIds("panes", [AGENT_ID]);
    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toEqual({ status: "painted", items: [item("cached", "cached", 8)] });
    expect(rows.get(AGENT_ID)?.range).toEqual({ epoch: "epoch-1", startSeq: 5, endSeq: 8 });
    expect(fetchRequests.findLast((entry) => entry.agentId === AGENT_ID)).toEqual({
      agentId: AGENT_ID,
      request: {
        direction: "after",
        cursor: { epoch: "epoch-1", seq: 8 },
        limit: 40,
        projection: "projected",
      },
    });

    owner.applyTimelineResponse(
      timelinePage({
        requestId: "resume",
        agentId: AGENT_ID,
        direction: "after",
        startSeq: 9,
        endSeq: 9,
        text: "current tail",
      }),
    );
    expect(
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
    ).toMatchObject({
      status: "synced",
      older: "available",
      range: { epoch: "epoch-1", startSeq: 5, endSeq: 9 },
    });

    // Older history stayed reachable: the adjacent backward page still installs.
    owner.applyTimelineResponse(
      timelinePage({
        requestId: "older",
        agentId: AGENT_ID,
        direction: "before",
        startSeq: 1,
        endSeq: 4,
        text: "older history",
        hasOlder: false,
        kind: "user_message",
      }),
    );
    const rebuilt = selectAgentTimelineState(
      useSessionStore.getState().sessions[SERVER_ID],
      AGENT_ID,
    );
    expect(rebuilt).toMatchObject({
      status: "synced",
      older: "none",
      range: { epoch: "epoch-1", startSeq: 1, endSeq: 9 },
    });
    // The older page's row is displayed and its coverage extends backward from the cached window.
    const texts =
      rebuilt.status === "cold"
        ? []
        : rebuilt.items.map((entry) =>
            entry.kind === "user_message" || entry.kind === "assistant_message"
              ? entry.text
              : entry.kind,
          );
    expect(texts).toContain("older history");
    expect(rebuilt.status === "cold" ? [] : rebuilt.items).toHaveLength(2);
    owner.dispose();
  });

  it("keeps the released transcript durable until the agent is deleted", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { cache, database } = createSqliteCache();
    cache.setHosts([SERVER_ID]);
    const { owner } = createSelectiveOwner(cache);
    owner.setConnected(true);
    owner.replaceVisibleAgentIds("panes", [AGENT_ID]);
    applySyncedTimeline(AGENT_ID, [item("cold", "cold", 8)], { startSeq: 1, endSeq: 8 });

    for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) visitAgent(owner, agentId, 8);

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toEqual({ status: "cold" });
    await cache.flush();
    const stored = await cache.readTimeline(SERVER_ID, AGENT_ID);
    expect(stored?.items.map((entry) => entry.id)).toEqual(["cold"]);
    expect(stored?.range).toEqual({ epoch: "epoch-1", startSeq: 1, endSeq: 8 });

    cache.commitDirectoryMutations(SERVER_ID, [{ kind: "agent", type: "delete", id: AGENT_ID }]);
    await cache.flush();
    expect(await cache.readTimeline(SERVER_ID, AGENT_ID)).toBeUndefined();
    owner.dispose();
    database.close();
  });

  it("keeps a released transcript cold across a delivery-mode round trip", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { storage, rows, commits } = createMemoryTimelineStorage();
    const { owner } = createSelectiveOwner(storage);
    owner.setConnected(true);
    owner.replaceVisibleAgentIds("panes", [AGENT_ID]);
    applySyncedTimeline(AGENT_ID, [item("cached", "cached", 8)], { startSeq: 5, endSeq: 8 });

    for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) visitAgent(owner, agentId, 8);

    await expect
      .poll(() =>
        selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
      )
      .toEqual({ status: "cold" });
    const commitsAfterRelease = commits.filter((agentId) => agentId === AGENT_ID).length;

    // Legacy hosts stream every agent, so a frame recorded before the release can arrive in the
    // middle of the legacy interlude. It is delivered after the mode has changed twice.
    owner.setDeliveryMode("legacy");
    owner.setDeliveryMode("selective");
    owner.applyTimelineResponse(
      timelinePage({
        requestId: "stale-across-modes",
        agentId: AGENT_ID,
        direction: "tail",
        startSeq: 1,
        endSeq: 8,
        text: "stale",
      }),
    );
    // The fence outlived both transitions: the released display was not repainted or persisted.
    const session = () => useSessionStore.getState().sessions[SERVER_ID];
    expect(selectAgentTimelineState(session(), AGENT_ID)).toEqual({ status: "cold" });
    expect(rows.get(AGENT_ID)?.items.map((entry) => entry.id)).toEqual(["cached"]);
    expect(commits.filter((agentId) => agentId === AGENT_ID)).toHaveLength(commitsAfterRelease);

    // Wanting the agent again is the only thing that retires the fence, and it rebuilds from the
    // durable snapshot rather than from the stale page.
    owner.replaceVisibleAgentIds("panes", [AGENT_ID]);
    await expect
      .poll(() => selectAgentTimelineState(session(), AGENT_ID))
      .toEqual({
        status: "painted",
        items: [item("cached", "cached", 8)],
      });
    owner.dispose();
  });

  it("releases a transcript legacy delivery repopulated after its release", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { storage, rows, commits } = createMemoryTimelineStorage();
    const { owner } = createSelectiveOwner(storage);
    owner.setConnected(true);
    owner.replaceVisibleAgentIds("panes", [AGENT_ID]);
    applySyncedTimeline(AGENT_ID, [item("cached", "cached", 8)], { startSeq: 5, endSeq: 8 });

    for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) visitAgent(owner, agentId, 8);

    const status = () =>
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID);
    await expect.poll(status).toEqual({ status: "cold" });
    expect(rows.get(AGENT_ID)?.items.map((entry) => entry.id)).toEqual(["cached"]);
    const commitsAfterRelease = commits.filter((agentId) => agentId === AGENT_ID).length;

    // Legacy delivery reports no stale transcript, so this page is accepted and repopulates the
    // released arrays.
    owner.setDeliveryMode("legacy");
    owner.applyTimelineResponse(
      timelinePage({
        requestId: "legacy-repopulate",
        agentId: AGENT_ID,
        direction: "tail",
        startSeq: 6,
        endSeq: 8,
        text: "repopulated",
      }),
    );
    expect(status().status).toBe("synced");

    // The release bookkeeping survived the interlude under the mode that produced it, so the
    // acknowledgement sweep drops the arrays the legacy page re-created and persists what was
    // displayed — exactly as it does for the original release.
    owner.setDeliveryMode("selective");
    await expect.poll(status).toEqual({ status: "cold" });
    expect(commits.filter((agentId) => agentId === AGENT_ID).length).toBeGreaterThan(
      commitsAfterRelease,
    );
    expect(
      rows
        .get(AGENT_ID)
        ?.items.filter(
          (entry): entry is Extract<StreamItem, { kind: "assistant_message" }> =>
            entry.kind === "assistant_message",
        )
        .map((entry) => entry.text),
    ).toContain("repopulated");

    // The fence still stands, so a page recorded under the release is dropped.
    const commitsAfterRecovery = commits.filter((agentId) => agentId === AGENT_ID).length;
    owner.applyTimelineResponse(
      timelinePage({
        requestId: "late-selective",
        agentId: AGENT_ID,
        direction: "tail",
        startSeq: 6,
        endSeq: 8,
        text: "late",
      }),
    );
    expect(status()).toEqual({ status: "cold" });
    expect(commits.filter((agentId) => agentId === AGENT_ID)).toHaveLength(commitsAfterRecovery);
    owner.dispose();
  });

  it("tracks buffered legacy updates before the delivery mode changes", async () => {
    useSessionStore.getState().initializeSession(SERVER_ID, null);
    const { storage, rows } = createMemoryTimelineStorage();
    const { owner } = createSelectiveOwner(storage);
    owner.setConnected(true);
    owner.replaceVisibleAgentIds("panes", [AGENT_ID]);
    applySyncedTimeline(AGENT_ID, [item("cached", "cached", 8)], { startSeq: 5, endSeq: 8 });
    for (const agentId of RELEASE_WORKLOAD_AGENT_IDS) visitAgent(owner, agentId, 8);
    const status = () =>
      selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID);
    await expect.poll(status).toEqual({ status: "cold" });

    owner.setDeliveryMode("legacy");
    // Seed canonical coverage independently to isolate stream admission from page admission.
    applySyncedTimeline(AGENT_ID, [item("cached", "cached", 8)], { startSeq: 5, endSeq: 8 });
    owner.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "buffered legacy", messageId: "legacy-live" },
      } as AgentStreamEventPayload,
      seq: 9,
      epoch: "epoch-1",
      timestamp: new Date("2026-08-26T10:00:01.000Z"),
    });
    owner.setDeliveryMode("selective");
    await expect.poll(status).toEqual({ status: "cold" });
    expect(
      [...(rows.get(AGENT_ID)?.items ?? []), ...(rows.get(AGENT_ID)?.head ?? [])].some(
        (entry) => entry.kind === "assistant_message" && entry.text === "buffered legacy",
      ),
    ).toBe(true);
    owner.dispose();
  });
});
