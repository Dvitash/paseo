import {
  planTimelineCatchUpAfter,
  planTimelineResumeFetch,
  type ProjectedTimelineForwardFetchPlan,
} from "./timeline-sync-plan";
import { isTimelineItemCoveredByRange, type CachedTimeline } from "@/runtime/replica-cache";
import {
  selectAgentTimelineState,
  useSessionStore,
  type AgentTimelineCursorState,
  type AgentTimelineState,
  type SessionState,
} from "@/stores/session-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import {
  getActiveMessageSubmissions,
  getSendingClientMessageIds,
} from "@/composer/submission/model";
import {
  getInitDeferred,
  getInitKey,
  rejectInitDeferred,
  resolveInitDeferred,
} from "@/utils/agent-initialization";
import {
  createSessionAgentStreamReducerQueue,
  type AgentStreamReducerEvent,
  type ProcessTimelineResponseOutput,
  processTimelineResponse,
} from "./session-stream-reducers";
import { isTimelineResumeSnapshotAuthoritative } from "./timeline-sync-plan";
import { replaceWithCanonicalStream } from "@/types/stream";

export interface TimelineReplicaStorage {
  readTimeline(serverId: string, agentId: string): Promise<CachedTimeline | undefined>;
  commitTimeline(serverId: string, agentId: string, timeline: CachedTimeline): void;
}

async function prepareCachedTimeline(input: {
  serverId: string;
  agentId: string;
  storage: TimelineReplicaStorage;
  prepareAgent: (agentId: string) => Promise<void>;
}): Promise<CachedTimeline | undefined> {
  const before = useSessionStore.getState().sessions[input.serverId];
  const beforeTimeline = selectAgentTimelineState(before, input.agentId);
  if (beforeTimeline.status === "synced") return undefined;
  const [stored] = await Promise.all([
    input.storage.readTimeline(input.serverId, input.agentId),
    input.prepareAgent(input.agentId),
  ]);
  if (!stored) return undefined;
  const session = useSessionStore.getState().sessions[input.serverId];
  const currentTimeline = selectAgentTimelineState(session, input.agentId);
  const currentHead = session?.agentStreamHead.get(input.agentId);
  if (currentTimeline.status === "synced") return undefined;
  if (!stored.range) {
    if (beforeTimeline.status === "painted") {
      return currentTimeline.status === "painted" && currentTimeline.items === beforeTimeline.items
        ? stored
        : undefined;
    }
    if (currentTimeline.status !== "cold") return undefined;
  }
  const liveItems =
    currentTimeline.status === "painted"
      ? [...currentTimeline.items, ...(currentHead ?? [])]
      : (currentHead ?? []);
  const replacement = replaceWithCanonicalStream({
    canonical: stored.items,
    previousTail: [],
    previousHead: liveItems,
    sendingClientMessageIds: getSendingClientMessageIds(
      session?.messageSubmissions.get(input.agentId),
    ),
    preserveContinuity: true,
    // Display-only rows claim no coverage over the live head.
    canonicalCoverage: stored.range ?? {
      epoch: liveItems.find((item) => item.timelineCursor)?.timelineCursor?.epoch ?? "",
      endSeq: null,
    },
  });
  useSessionStore.getState().applyAgentTimelineResponseState(input.serverId, input.agentId, {
    items: replacement.tail,
    head: replacement.head,
    range: stored.range,
    older: stored.hasOlder ? "available" : "none",
    newer: false,
    synchronized: false,
    acknowledgedClientMessageIds: replacement.acknowledgedClientMessageIds,
  });
  return stored;
}

export interface TimelineReplica {
  prepare(agentId: string): Promise<void>;
  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined;
  readRange(agentId: string): AgentTimelineCursorState | undefined;
  timelineUpdated(agentId: string): void;
  /**
   * Forgets the in-memory transcript of an agent the app no longer subscribes to. The durable
   * snapshot is committed first, so the agent keeps its bounded stored timeline and the store only
   * loses the copy it can rebuild. Returns false without changing anything when the display is not
   * safely reconstructible.
   */
  release(agentId: string): boolean;
}

class TimelineReplicaOwner implements TimelineReplica {
  private readonly cachedRanges = new Map<string, AgentTimelineCursorState>();
  private readonly preparations = new Map<string, Promise<void>>();

  constructor(
    private readonly serverId: string,
    private readonly storage: TimelineReplicaStorage,
    private readonly prepareAgent: (agentId: string) => Promise<void>,
  ) {}

  async prepare(agentId: string): Promise<void> {
    const existing = this.preparations.get(agentId);
    if (existing) return existing;
    const preparation = this.load(agentId).finally(() => {
      if (this.preparations.get(agentId) === preparation) {
        this.preparations.delete(agentId);
      }
    });
    this.preparations.set(agentId, preparation);
    return preparation;
  }

  private async load(agentId: string): Promise<void> {
    const stored = await prepareCachedTimeline({
      serverId: this.serverId,
      agentId,
      storage: this.storage,
      prepareAgent: this.prepareAgent,
    });
    if (!stored) return;
    if (stored.range) {
      this.cachedRanges.set(agentId, stored.range);
    }
  }

  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined {
    const range = this.cachedRanges.get(agentId);
    return range ? { epoch: range.epoch, endSeq: range.endSeq } : undefined;
  }

  readRange(agentId: string): AgentTimelineCursorState | undefined {
    return this.cachedRanges.get(agentId);
  }

  timelineUpdated(agentId: string): void {
    const session = useSessionStore.getState().sessions[this.serverId];
    const timeline = selectAgentTimelineState(session, agentId);
    if (timeline.status === "cold") return;
    if (timeline.status === "synced") this.cachedRanges.delete(agentId);
    // Stream-owned tail and head arrays are immutable snapshots; persistence joins them once, for
    // the bounded window it writes, instead of copying the visible history on every commit.
    const head = session?.agentStreamHead.get(agentId);
    this.storage.commitTimeline(this.serverId, agentId, {
      agentId,
      items: timeline.items,
      ...(head ? { head } : {}),
      range: timeline.status === "synced" ? timeline.range : null,
      hasOlder: timeline.status === "synced" && timeline.older === "available",
    });
  }

  release(agentId: string): boolean {
    if (this.preparations.has(agentId)) return false;
    const session = useSessionStore.getState().sessions[this.serverId];
    if (!session) return false;
    if (!isTranscriptReconstructible(session, agentId)) return false;
    // Commit the exact rows about to be dropped before dropping them: the durable snapshot is the
    // only remaining copy, and it must describe the display the user last saw.
    this.timelineUpdated(agentId);
    if (!useSessionStore.getState().releaseAgentTimelineTranscript(this.serverId, agentId)) {
      return false;
    }
    this.cachedRanges.delete(agentId);
    return true;
  }
}

/**
 * Whether the store's in-memory display for `agentId` is a transcript the daemon can rebuild:
 * authoritative coverage exists, every displayed row sits inside that coverage and serializes
 * losslessly, and no row is local-only presentation the transcript cannot reproduce.
 *
 * Streaming is not a disqualifier. A positioned head row is canonical history the daemon still
 * serves; a cursorless or enriched row is a local artifact it does not. An evicted running agent
 * whose completion never arrives is exactly the case that must not pin memory forever, provided
 * nothing it holds is only in memory.
 */
function isTranscriptReconstructible(session: SessionState, agentId: string): boolean {
  const timeline = selectAgentTimelineState(session, agentId);
  if (timeline.status !== "synced" || !timeline.range) return false;
  const range = timeline.range;
  // A retained-range cursor describes discontiguous coverage, which the bounded snapshot cannot
  // express; releasing would silently shrink what the user can scroll to.
  if (range.retainedRanges !== undefined) return false;
  // Unsynced or initializing timelines are still being built, and a pending older page belongs to
  // the history this release would drop.
  if (session.initializingAgents.get(agentId) === true) return false;
  if (session.agentTimelineOlderFetchInFlight.get(agentId) === true) return false;
  // An unacknowledged submission still owns its local row: the daemon may never confirm it, and a
  // settled transport error can still roll it back.
  if (getActiveMessageSubmissions(session.messageSubmissions.get(agentId)).length > 0) return false;
  const head = session.agentStreamHead.get(agentId) ?? [];
  for (const item of [...timeline.items, ...head]) {
    if (!isTimelineItemCoveredByRange(item, range)) return false;
  }
  return true;
}

export function createTimelineReplica(input: {
  serverId: string;
  storage: TimelineReplicaStorage;
  prepareAgent: (agentId: string) => Promise<void>;
}): TimelineReplica {
  return new TimelineReplicaOwner(input.serverId, input.storage, input.prepareAgent);
}

export interface TimelinePageResult {
  hasNewer: boolean;
  endCursor: { epoch: string; seq: number } | null;
}

export type TimelineResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agent_timeline_response" }
>["payload"];

export function consumeForcedTimelineTailReplacement(
  payload: TimelineResponsePayload,
  replacements: Set<string>,
): TimelineResponsePayload {
  if (payload.direction !== "tail") return payload;
  if (!replacements.delete(payload.agentId)) return payload;
  return { ...payload, reset: true };
}

function clearAgentInitializingFlag(serverId: string, agentId: string): void {
  useSessionStore.getState().setInitializingAgents(serverId, (previous) => {
    if (previous.get(agentId) !== true) return previous;
    const next = new Map(previous);
    next.set(agentId, false);
    return next;
  });
}

function commitProcessedTimeline(input: {
  serverId: string;
  payload: TimelineResponsePayload;
  result: ProcessTimelineResponseOutput;
  timeline: AgentTimelineState;
  currentCursor: AgentTimelineCursorState | undefined;
  synchronized: boolean;
}): void {
  const { serverId, payload, result, timeline, currentCursor, synchronized } = input;
  const agentId = payload.agentId;
  const store = useSessionStore.getState();
  if (result.commit !== "discard") {
    store.applyAgentTimelineResponseState(serverId, agentId, {
      items: result.tail,
      head: result.head,
      range: result.cursorChanged ? (result.cursor ?? null) : (currentCursor ?? null),
      older: result.older,
      newer:
        payload.direction === "before"
          ? timeline.status === "synced" && timeline.newer === "available"
          : payload.hasNewer,
      synchronized,
      acknowledgedClientMessageIds: result.acknowledgedClientMessageIds,
    });
    return;
  }
  if (result.acknowledgedClientMessageIds.length > 0) {
    store.setAgentStreamState(serverId, agentId, {
      acknowledgedClientMessageIds: result.acknowledgedClientMessageIds,
    });
  }
  if (payload.direction !== "before") {
    store.setAgentTimelineHasNewer(serverId, (current) => {
      const next = new Map(current);
      next.set(agentId, payload.hasNewer);
      return next;
    });
  }
  store.markAgentHistorySynchronized(serverId, agentId);
}

function finalizeProcessedTimeline(input: {
  serverId: string;
  agentId: string;
  initKey: string;
  result: ProcessTimelineResponseOutput;
  synchronized: boolean;
  recoverGap: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
}): void {
  for (const effect of input.result.sideEffects) {
    if (effect.type === "catch_up") input.recoverGap(input.agentId, effect.cursor);
  }
  if (input.result.clearInitializing) {
    clearAgentInitializingFlag(input.serverId, input.agentId);
  }
  if (input.synchronized) {
    useCreateFlowStore
      .getState()
      .clearByAgent({ serverId: input.serverId, agentId: input.agentId });
    const session = useSessionStore.getState().sessions[input.serverId];
    const agent = session?.agents.get(input.agentId) ?? session?.agentDetails.get(input.agentId);
    if (agent && agent.turn.phase === "idle") input.drainQueuedAgentMessage(input.agentId);
  }
  if (input.result.initResolution === "resolve") resolveInitDeferred(input.initKey);
}

function applyAuthoritativeTimelineResponse(input: {
  serverId: string;
  payload: TimelineResponsePayload;
  cachedCursor?: AgentTimelineCursorState;
  recoverGap: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
}): boolean {
  const { serverId, payload } = input;
  const agentId = payload.agentId;
  const initKey = getInitKey(serverId, agentId);
  const session = useSessionStore.getState().sessions[serverId];
  const timeline = selectAgentTimelineState(session, agentId);
  const activeInitDeferred = getInitDeferred(initKey);
  const currentCursor =
    timeline.status === "synced" ? (timeline.range ?? undefined) : input.cachedCursor;
  const result = processTimelineResponse({
    payload,
    currentTail: timeline.status === "cold" ? [] : timeline.items,
    currentHead: session?.agentStreamHead.get(agentId) ?? [],
    currentCursor,
    isInitializing: session?.initializingAgents.get(agentId) === true,
    hasActiveInitDeferred: Boolean(activeInitDeferred),
    initRequestDirection: activeInitDeferred?.requestDirection ?? "tail",
    sendingClientMessageIds: getSendingClientMessageIds(session?.messageSubmissions.get(agentId)),
  });

  if (result.error) {
    if (result.clearInitializing) clearAgentInitializingFlag(serverId, agentId);
    if (result.initResolution === "reject") rejectInitDeferred(initKey, new Error(result.error));
    return false;
  }

  const synchronized = isTimelineResumeSnapshotAuthoritative({
    direction: payload.direction,
    hasNewer: payload.hasNewer,
    error: payload.error,
  });
  commitProcessedTimeline({ serverId, payload, result, timeline, currentCursor, synchronized });
  finalizeProcessedTimeline({
    serverId,
    agentId,
    initKey,
    result,
    synchronized,
    recoverGap: input.recoverGap,
    drainQueuedAgentMessage: input.drainQueuedAgentMessage,
  });
  return true;
}

export interface ViewedTimelineSyncPorts {
  initialDeliveryMode: TimelineDeliveryMode;
  prepare(agentId: string): Promise<void>;
  replaceDemandedAgentIds(agentIds: string[]): void;
  setSubscription(agentIds: string[]): Promise<void>;
  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined;
  fetchPage(
    agentId: string,
    request: ProjectedTimelineForwardFetchPlan,
  ): Promise<TimelinePageResult>;
  fetchLatestTail(agentId: string): Promise<TimelinePageResult>;
  reportError(error: unknown): void;
  schedule(task: () => void, delayMs: number): () => void;
  /**
   * Attempts to release one inactive agent's in-memory transcript. Returns false while the
   * transcript is protected — initializing, awaiting an in-flight fetch or cache preparation,
   * holding local presentation the transcript cannot reproduce, or not covered by an authoritative
   * range — and the sync model retries at the next settlement.
   */
  releaseTranscript(agentId: string): boolean;
}

export type TimelineDeliveryMode = "legacy" | "selective";
export type ViewedTimelineStatus = "ready" | "pending" | "error" | "retrying";

export interface ViewedTimelineUiBridge {
  replaceVisibleAgentIds(sourceId: string, agentIds: string[]): void;
  subscribe(listener: () => void): () => void;
  getAgentTimelineStatus(agentId: string): ViewedTimelineStatus;
  getAgentTimelineError(agentId: string): string | null;
  retryVisibleAgentTimeline(agentId: string): void;
}

export interface ViewedTimelineSync extends ViewedTimelineUiBridge {
  setActive(active: boolean): void;
  setConnected(connected: boolean): void;
  setDeliveryMode(mode: TimelineDeliveryMode): void;
  recoverGap(agentId: string, cursor: { epoch: string; endSeq: number }): void;
  dispose(): void;
  /**
   * Whether this agent's in-memory transcript was released and the agent has not been wanted
   * again since. Pages and stream frames issued before that release are stale for it.
   */
  isTranscriptReleased(agentId: string): boolean;
  /**
   * Records that an accepted delivery repopulated a transcript this sync had released. Legacy
   * delivery never fences a release, so a frame admitted while a fence stood left resident arrays
   * that no bookkeeping knew about. The fence is kept; only evictability is restored.
   */
  noteTranscriptUpdate(agentId: string): void;
  /**
   * Re-attempts release of inactive transcripts. The owner calls it when protected work settles —
   * an applied response, a committed stream batch — so a deferred release is not pinned forever.
   */
  releaseInactiveTranscripts(): void;
}

export type ViewedTimelineOwnerPorts = Omit<
  ViewedTimelineSyncPorts,
  "prepare" | "replaceDemandedAgentIds" | "releaseTranscript"
>;

export interface ViewedTimelineOwner extends ViewedTimelineSync {
  applyTimelineResponse(payload: TimelineResponsePayload): void;
  enqueueStreamEvent(agentId: string, event: AgentStreamReducerEvent): void;
  flushStreamAgent(agentId: string): void;
}

export function createViewedTimelineOwner(input: {
  serverId: string;
  replica: TimelineReplica;
  replaceDemandedAgentIds: (agentIds: string[]) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
  ports: ViewedTimelineOwnerPorts;
}): ViewedTimelineOwner {
  const sync = createViewedTimelineSync({
    ...input.ports,
    prepare: (agentId) => input.replica.prepare(agentId),
    readCursor: (agentId) => input.replica.readCursor(agentId) ?? input.ports.readCursor(agentId),
    replaceDemandedAgentIds: input.replaceDemandedAgentIds,
    releaseTranscript: (agentId) => {
      // Queued deltas belong to the transcript being judged: commit them before the release
      // decides whether what is displayed is reconstructible, or they would be dropped with it.
      streamQueue.flushAgent(agentId);
      return input.replica.release(agentId);
    },
  });
  const streamQueue = createSessionAgentStreamReducerQueue({
    serverId: input.serverId,
    setAgentStreamState: (...args) => useSessionStore.getState().setAgentStreamState(...args),
    setAgentTimelineCursor: (...args) => useSessionStore.getState().setAgentTimelineCursor(...args),
    recoverTimelineGap: (agentId, cursor) => sync.recoverGap(agentId, cursor),
    onCommitted: (agentId) => input.replica.timelineUpdated(agentId),
  });
  return {
    ...sync,
    applyTimelineResponse(payload) {
      if (sync.isTranscriptReleased(payload.agentId)) return;
      const accepted = applyAuthoritativeTimelineResponse({
        serverId: input.serverId,
        payload,
        cachedCursor: input.replica.readRange(payload.agentId),
        recoverGap: (agentId, cursor) => sync.recoverGap(agentId, cursor),
        drainQueuedAgentMessage: input.drainQueuedAgentMessage,
      });
      if (accepted) {
        input.replica.timelineUpdated(payload.agentId);
        // An accepted page is an update to what is displayed, which is exactly what a release
        // judged; it may have repopulated the released transcript through the legacy hole.
        sync.noteTranscriptUpdate(payload.agentId);
      }
      sync.releaseInactiveTranscripts();
    },
    enqueueStreamEvent(agentId, event) {
      if (sync.isTranscriptReleased(agentId)) return;
      // Track admission before buffering: the delivery mode can change before this batch commits.
      sync.noteTranscriptUpdate(agentId);
      streamQueue.enqueue(agentId, event);
    },
    flushStreamAgent(agentId) {
      if (sync.isTranscriptReleased(agentId)) return;
      streamQueue.flushAgent(agentId);
    },
    dispose() {
      streamQueue.dispose({ flush: true });
      sync.dispose();
    },
  };
}

const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const VIEWED_TIMELINE_HOT_AGENT_LIMIT = 5;

type CatchUpStatus = "running" | "complete" | "error";

interface CatchUpState {
  generation: number;
  status: CatchUpStatus;
  request?: ProjectedTimelineForwardFetchPlan;
  cancelRetry?: () => void;
  retryDelayMs?: number;
}

const getNextRetryDelayMs = (previousDelayMs: number | undefined): number => {
  if (previousDelayMs == null) {
    return RETRY_DELAY_MS;
  }
  return Math.min(previousDelayMs * 2, MAX_RETRY_DELAY_MS);
};

function isSameCatchUpRequest(
  left: ProjectedTimelineForwardFetchPlan | undefined,
  right: ProjectedTimelineForwardFetchPlan | undefined,
): boolean {
  if (!left || !right || left.direction !== right.direction) return false;
  if (left.direction !== "after" || right.direction !== "after") return true;
  return left.cursor.epoch === right.cursor.epoch && left.cursor.seq === right.cursor.seq;
}

type CatchUpDecision = "keep" | "keep-and-park" | "replace";

function decideCatchUp(input: {
  current: CatchUpState | undefined;
  request: ProjectedTimelineForwardFetchPlan;
  supersede: boolean;
}): CatchUpDecision {
  if (!input.current) return "replace";
  if (input.supersede) {
    if (
      input.current.status === "running" &&
      isSameCatchUpRequest(input.current.request, input.request)
    ) {
      return "keep";
    }
    if (input.current.status === "running" && input.current.request?.direction === "tail") {
      return "keep-and-park";
    }
    return "replace";
  }
  return input.current.status === "running" || input.current.status === "complete"
    ? "keep"
    : "replace";
}

function normalizeAgentIds(agentIds: string[]): string[] {
  return [...new Set(agentIds)].filter(Boolean).sort();
}

function sameAgentIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((agentId, index) => agentId === right[index]);
}

export function createViewedTimelineSync(ports: ViewedTimelineSyncPorts): ViewedTimelineSync {
  const sources = new Map<string, string[]>();
  const catchUps = new Map<string, CatchUpState>();
  const catchUpGenerations = new Map<string, number>();
  // Authoritative fetch owed but not runnable yet: disconnected, unacknowledged, or parked.
  // Acknowledgement and tail completion are the only drain points.
  const pendingCatchUps = new Map<string, ProjectedTimelineForwardFetchPlan>();
  const visibilityCatchUpPending = new Set<string>();
  const visibilityCatchUpErrors = new Map<string, string>();
  // User-initiated retries only. Background retries stay silent; a retry the user asked for
  // owes them a pending state until it settles.
  const manualRetries = new Set<string>();
  const loadedCache = new Set<string>();
  const cacheLoads = new Map<string, Promise<void>>();
  // Agents that left the requested set and have not been released yet. Releasing needs the
  // daemon's confirmed membership to exclude the agent, so eviction alone is not enough.
  const releaseCandidates = new Set<string>();
  // Transcripts this sync dropped while the agent was outside the selective hot set. A page or
  // stream frame issued before the release must not rebuild what the daemon still serves on
  // demand; requiring the agent again clears the fence in `ensureCacheLoaded`.
  const releasedTranscripts = new Set<string>();
  // Agents with sync-owned fetches outstanding, counted per agent: a superseding catch-up leaves
  // the fetch it replaced in flight, so only the last one settling may release the transcript. A
  // release needs every response already on its way applied to the transcript it belongs to.
  const inFlightFetches = new Map<string, number>();
  let releaseSweepRunning = false;
  const listeners = new Set<() => void>();
  let active = true;
  let connected = false;
  let deliveryMode = ports.initialDeliveryMode;
  let disposed = false;
  let desired: string[] = [];
  let acknowledged: string[] = [];
  let membershipGeneration = 0;
  let reconciling = false;
  let reconcileRequested = false;
  let membershipNeedsRetry = false;
  let membershipRetryDelayMs: number | undefined;
  let cancelMembershipRetry: (() => void) | null = null;
  let recentlyViewedAgentIds: string[] = [];

  const visibleAgentIds = () => normalizeAgentIds([...sources.values()].flat());

  const selectHotAgentIds = (visible: string[]) => {
    const visibleSet = new Set(visible);
    recentlyViewedAgentIds = [
      ...visible,
      ...recentlyViewedAgentIds.filter((agentId) => !visibleSet.has(agentId)),
    ];
    const hiddenBudget = Math.max(0, VIEWED_TIMELINE_HOT_AGENT_LIMIT - visible.length);
    const desiredAgentIds = normalizeAgentIds([
      ...visible,
      ...recentlyViewedAgentIds
        .filter((agentId) => !visibleSet.has(agentId))
        .slice(0, hiddenBudget),
    ]);
    const desiredSet = new Set(desiredAgentIds);
    recentlyViewedAgentIds = recentlyViewedAgentIds.filter((agentId) => desiredSet.has(agentId));
    return desiredAgentIds;
  };

  const isAcknowledged = (agentId: string) => acknowledged.includes(agentId);
  const isDesired = (agentId: string) => desired.includes(agentId);
  const ownsCatchUp = (agentId: string, generation: number) =>
    !disposed &&
    connected &&
    isDesired(agentId) &&
    isAcknowledged(agentId) &&
    catchUps.get(agentId)?.generation === generation;

  const notifyListeners = () => {
    for (const listener of listeners) listener();
  };

  const setVisibilityCatchUpReady = (agentId: string) => {
    const wasPending = visibilityCatchUpPending.delete(agentId);
    const hadError = visibilityCatchUpErrors.delete(agentId);
    const wasRetrying = manualRetries.delete(agentId);
    if (wasPending || hadError || wasRetrying) notifyListeners();
  };

  const setVisibilityCatchUpError = (agentIds: string[], error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    let changed = false;
    for (const agentId of agentIds) {
      if (manualRetries.delete(agentId)) changed = true;
      if (visibilityCatchUpPending.delete(agentId)) changed = true;
      if (visibilityCatchUpErrors.get(agentId) !== message) {
        visibilityCatchUpErrors.set(agentId, message);
        changed = true;
      }
    }
    if (changed) notifyListeners();
  };

  const cancelCatchUp = (agentId: string) => {
    catchUpGenerations.set(agentId, (catchUpGenerations.get(agentId) ?? 0) + 1);
    catchUps.get(agentId)?.cancelRetry?.();
    catchUps.delete(agentId);
    pendingCatchUps.delete(agentId);
  };

  const isVisibleInAnySource = (agentId: string) => {
    for (const sourceAgentIds of sources.values()) {
      if (sourceAgentIds.includes(agentId)) return true;
    }
    return false;
  };

  /**
   * Drops the in-memory transcript of every agent the daemon's confirmed membership no longer
   * includes. Only agents this sync prepared are candidates, and only for selective delivery:
   * legacy hosts keep streaming every agent, so there is nothing to release.
   *
   * Protected in-flight work — a fetch or a cache preparation — defers its agent to the next
   * settlement. There is no per-agent retry timer: every settle point (membership
   * acknowledgement, fetch, cache load, applied response, foreground) sweeps the same candidates.
   */
  const releaseInactiveTranscripts = () => {
    if (disposed || !connected || !active || deliveryMode !== "selective") return;
    if (releaseSweepRunning || releaseCandidates.size === 0) return;
    releaseSweepRunning = true;
    try {
      // Snapshot: `releaseTranscript` runs synchronously and its callers can republish
      // membership, mutating the candidate set while this sweep is iterating it.
      for (const agentId of Array.from(releaseCandidates)) {
        if (isDesired(agentId) || isAcknowledged(agentId) || isVisibleInAnySource(agentId)) {
          continue;
        }
        if (cacheLoads.has(agentId) || inFlightFetches.has(agentId)) continue;
        if (!loadedCache.has(agentId)) continue;
        if (!ports.releaseTranscript(agentId)) continue;
        releaseCandidates.delete(agentId);
        loadedCache.delete(agentId);
        releasedTranscripts.add(agentId);
      }
    } finally {
      releaseSweepRunning = false;
    }
  };

  const runTrackedFetch = async <T>(agentId: string, run: () => Promise<T>): Promise<T> => {
    inFlightFetches.set(agentId, (inFlightFetches.get(agentId) ?? 0) + 1);
    try {
      return await run();
    } finally {
      // Defensive read: `dispose` clears the map, and the settle must not revive the count.
      const remaining = (inFlightFetches.get(agentId) ?? 1) - 1;
      if (remaining === 0) inFlightFetches.delete(agentId);
      else inFlightFetches.set(agentId, remaining);
      releaseInactiveTranscripts();
    }
  };

  const fetchUntilCurrent = async (
    agentId: string,
    generation: number,
    request: ProjectedTimelineForwardFetchPlan,
    fallbackToLatestTailOnOverflow: boolean,
  ): Promise<void> => {
    if (!ownsCatchUp(agentId, generation)) return;

    try {
      const page = await runTrackedFetch(agentId, () => ports.fetchPage(agentId, request));
      if (!ownsCatchUp(agentId, generation)) return;
      if (page.hasNewer && page.endCursor) {
        if (fallbackToLatestTailOnOverflow) {
          await runTrackedFetch(agentId, () => ports.fetchLatestTail(agentId));
          catchUps.set(agentId, { generation, status: "complete" });
          setVisibilityCatchUpReady(agentId);
          return;
        }
        await fetchUntilCurrent(
          agentId,
          generation,
          planTimelineCatchUpAfter(page.endCursor),
          false,
        );
        return;
      }
      if (page.hasNewer) {
        throw new Error(`Timeline page for ${agentId} hasNewer without an end cursor`);
      }
      catchUps.set(agentId, { generation, status: "complete" });
      const pendingCatchUp = pendingCatchUps.get(agentId);
      if (pendingCatchUp) {
        startCatchUp(agentId, { request: pendingCatchUp, supersede: true });
        return;
      }
      setVisibilityCatchUpReady(agentId);
    } catch (error) {
      if (catchUps.get(agentId)?.generation === generation) {
        const nextRetryDelayMs = getNextRetryDelayMs(catchUps.get(agentId)?.retryDelayMs);
        const cancelRetry = ports.schedule(() => {
          const current = catchUps.get(agentId);
          if (current?.generation !== generation || current.status !== "error") return;
          startCatchUp(agentId);
        }, nextRetryDelayMs);
        catchUps.set(agentId, {
          generation,
          status: "error",
          request,
          cancelRetry,
          retryDelayMs: nextRetryDelayMs,
        });
        setVisibilityCatchUpError([agentId], error);
        ports.reportError(error);
      }
    }
  };

  const ensureCacheLoaded = (agentId: string): void => {
    // Preparing an agent means it is wanted again: late frames for a released transcript are no
    // longer stale, and the durable snapshot is re-painted below.
    releasedTranscripts.delete(agentId);
    if (loadedCache.has(agentId) || cacheLoads.has(agentId)) return;
    const load = ports
      .prepare(agentId)
      .catch((error) => ports.reportError(error))
      .finally(() => {
        cacheLoads.delete(agentId);
        // The cache preparation settled, so this agent's display is loaded. It stays true even if
        // the agent was evicted while the preparation was in flight — otherwise that transcript
        // could never be released. Only the catch-up needs the agent to still be wanted.
        loadedCache.add(agentId);
        if (isDesired(agentId)) {
          const pending = pendingCatchUps.get(agentId);
          startCatchUp(agentId, { request: pending, supersede: Boolean(pending) });
        }
        releaseInactiveTranscripts();
      });
    cacheLoads.set(agentId, load);
  };

  const startCatchUp = (
    agentId: string,
    options: {
      request?: ProjectedTimelineForwardFetchPlan;
      supersede?: boolean;
    } = {},
  ) => {
    const { request, supersede = false } = options;
    if (!connected || !isDesired(agentId) || !isAcknowledged(agentId)) {
      if (request) pendingCatchUps.set(agentId, request);
      return;
    }
    if (!loadedCache.has(agentId)) {
      if (request) pendingCatchUps.set(agentId, request);
      ensureCacheLoaded(agentId);
      return;
    }
    const nextRequest = request ?? planTimelineResumeFetch(ports.readCursor(agentId));
    const current = catchUps.get(agentId);
    const decision = decideCatchUp({ current, request: nextRequest, supersede });
    if (decision === "keep-and-park") {
      pendingCatchUps.set(agentId, nextRequest);
      return;
    }
    if (decision === "keep") {
      return;
    }
    current?.cancelRetry?.();
    const generation = (catchUpGenerations.get(agentId) ?? 0) + 1;
    catchUpGenerations.set(agentId, generation);
    const retryDelayMs =
      supersede || current?.status !== "error" ? undefined : current.retryDelayMs;
    catchUps.set(agentId, {
      generation,
      status: "running",
      request: nextRequest,
      retryDelayMs,
    });
    pendingCatchUps.delete(agentId);
    void fetchUntilCurrent(
      agentId,
      generation,
      nextRequest,
      request === undefined && nextRequest.direction === "after",
    );
  };

  const startAcknowledgedCatchUps = () => {
    for (const agentId of acknowledged) {
      const pendingCatchUp = pendingCatchUps.get(agentId);
      startCatchUp(agentId, {
        request: pendingCatchUp,
        supersede: Boolean(pendingCatchUp),
      });
    }
  };

  const reconcileLatestMembership = async (): Promise<void> => {
    if (disposed || !connected || deliveryMode !== "selective") return;
    const generation = membershipGeneration;
    const requested = desired;
    if (!membershipNeedsRetry && sameAgentIds(requested, acknowledged)) return;
    membershipNeedsRetry = false;
    try {
      await ports.setSubscription(requested);
    } catch (error) {
      membershipNeedsRetry = true;
      setVisibilityCatchUpError(requested, error);
      cancelMembershipRetry?.();
      const nextRetryDelayMs = getNextRetryDelayMs(membershipRetryDelayMs);
      cancelMembershipRetry = ports.schedule(() => {
        cancelMembershipRetry = null;
        if (
          disposed ||
          !connected ||
          membershipGeneration !== generation ||
          !sameAgentIds(desired, requested)
        ) {
          return;
        }
        void reconcileMembership();
      }, nextRetryDelayMs);
      membershipRetryDelayMs = nextRetryDelayMs;
      ports.reportError(error);
      return;
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    membershipRetryDelayMs = undefined;
    if (disposed || !connected || deliveryMode !== "selective") return;
    acknowledged = requested;
    // The daemon confirms the agent is outside the subscription: only now may its transcript go.
    releaseInactiveTranscripts();
    if (generation !== membershipGeneration) {
      await reconcileLatestMembership();
      return;
    }
    startAcknowledgedCatchUps();
    if (!sameAgentIds(desired, acknowledged)) await reconcileLatestMembership();
  };

  const reconcileMembership = async () => {
    if (reconciling) {
      reconcileRequested = true;
      return;
    }
    if (disposed || !connected) return;
    reconciling = true;
    try {
      await reconcileLatestMembership();
    } finally {
      reconciling = false;
      if (reconcileRequested && !disposed && connected && deliveryMode === "selective") {
        reconcileRequested = false;
        void reconcileMembership();
      } else if (
        !disposed &&
        connected &&
        deliveryMode === "selective" &&
        !membershipNeedsRetry &&
        !sameAgentIds(desired, acknowledged)
      ) {
        void reconcileMembership();
      }
    }
  };

  const retryVisibleAgentTimeline = (agentId: string) => {
    if (!isDesired(agentId) || manualRetries.has(agentId)) return;
    const catchUp = catchUps.get(agentId);
    const membershipRetryable = deliveryMode === "selective" && membershipNeedsRetry && connected;
    if (catchUp?.status !== "error" && !membershipRetryable) return;
    manualRetries.add(agentId);
    notifyListeners();
    if (catchUp?.status === "error") {
      catchUp.cancelRetry?.();
      startCatchUp(agentId, { request: catchUp.request, supersede: true });
      return;
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    membershipRetryDelayMs = undefined;
    membershipNeedsRetry = false;
    void reconcileMembership();
  };

  const commitDesiredMembership = (
    nextDesired: string[],
    options: { resetCatchUpStatus?: boolean } = {},
  ) => {
    let statusChanged = false;
    if (options.resetCatchUpStatus) {
      for (const agentId of nextDesired) {
        if (!visibilityCatchUpPending.has(agentId)) {
          visibilityCatchUpPending.add(agentId);
          statusChanged = true;
        }
        if (visibilityCatchUpErrors.delete(agentId)) statusChanged = true;
        if (manualRetries.delete(agentId)) statusChanged = true;
      }
    }
    if (sameAgentIds(nextDesired, desired)) {
      if (statusChanged) notifyListeners();
      releaseInactiveTranscripts();
      return;
    }

    for (const agentId of desired) {
      if (!nextDesired.includes(agentId)) {
        cancelCatchUp(agentId);
        visibilityCatchUpPending.delete(agentId);
        visibilityCatchUpErrors.delete(agentId);
        manualRetries.delete(agentId);
        releaseCandidates.add(agentId);
      }
    }
    for (const agentId of nextDesired) {
      if (!desired.includes(agentId)) {
        visibilityCatchUpPending.add(agentId);
        visibilityCatchUpErrors.delete(agentId);
        manualRetries.delete(agentId);
        releaseCandidates.delete(agentId);
        ensureCacheLoaded(agentId);
      }
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    desired = nextDesired;
    ports.replaceDemandedAgentIds(desired);
    membershipGeneration += 1;
    notifyListeners();
    if (deliveryMode === "legacy") {
      acknowledged = connected ? desired : [];
      if (connected) startAcknowledgedCatchUps();
      return;
    }
    void reconcileMembership();
  };

  const publishVisibleMembership = () => {
    const visible = visibleAgentIds();
    if (!connected || deliveryMode !== "selective") {
      const activeVisible = active ? visible : [];
      recentlyViewedAgentIds = activeVisible;
      commitDesiredMembership(activeVisible);
      return;
    }
    if (!active) return;
    commitDesiredMembership(selectHotAgentIds(visible));
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAgentTimelineStatus(agentId) {
      if (manualRetries.has(agentId)) return "retrying";
      if (visibilityCatchUpErrors.has(agentId)) return "error";
      if (!isDesired(agentId) || visibilityCatchUpPending.has(agentId)) return "pending";
      return "ready";
    },
    getAgentTimelineError(agentId) {
      return visibilityCatchUpErrors.get(agentId) ?? null;
    },
    replaceVisibleAgentIds(sourceId, agentIds) {
      const normalized = normalizeAgentIds(agentIds);
      if (normalized.length === 0) sources.delete(sourceId);
      else sources.set(sourceId, normalized);
      publishVisibleMembership();
    },
    setActive(nextActive) {
      if (active === nextActive) return;
      active = nextActive;
      publishVisibleMembership();
      releaseInactiveTranscripts();
    },
    setConnected(nextConnected) {
      if (connected === nextConnected) return;
      connected = nextConnected;
      if (!connected) {
        const visible = active ? visibleAgentIds() : [];
        recentlyViewedAgentIds = visible;
        commitDesiredMembership(visible, { resetCatchUpStatus: true });
        cancelMembershipRetry?.();
        cancelMembershipRetry = null;
        membershipRetryDelayMs = undefined;
        acknowledged = [];
        membershipGeneration += 1;
        for (const agentId of desired) cancelCatchUp(agentId);
        return;
      }
      membershipGeneration += 1;
      if (deliveryMode === "legacy") {
        acknowledged = desired;
        startAcknowledgedCatchUps();
      } else {
        void reconcileMembership();
      }
    },
    setDeliveryMode(nextMode) {
      if (deliveryMode === nextMode) return;
      deliveryMode = nextMode;
      cancelMembershipRetry?.();
      cancelMembershipRetry = null;
      membershipRetryDelayMs = undefined;
      membershipNeedsRetry = false;
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      const visible = active ? visibleAgentIds() : [];
      recentlyViewedAgentIds = visible;
      // This transition replaces `desired` directly instead of going through
      // `commitDesiredMembership`, so the agents it drops must be registered as release candidates
      // here. The transition narrows desired whenever the entered mode keeps a smaller set — only
      // the visible agents in selective delivery, and nothing at all while the app is backgrounded
      // — and a candidate that is never registered is a transcript the sweep can never evict.
      const nextDesired = new Set(visible);
      for (const agentId of desired) {
        if (!nextDesired.has(agentId)) releaseCandidates.add(agentId);
      }
      desired = visible;
      ports.replaceDemandedAgentIds(desired);
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      manualRetries.clear();
      // The transition itself releases nothing — the entered policy's confirmed membership is not
      // known yet — so the release bookkeeping is retained rather than rebuilt, because
      // `releaseInactiveTranscripts` already gates every release on desired, acknowledged, and
      // visible. Rebuilding it here can only lose information:
      //
      // - A selective candidate whose deferred release never ran (an in-flight fetch, a refused
      //   `releaseTranscript`) would be forgotten instead of retried at the next settlement.
      // - A released fence is not scoped to the mode that produced it. A page or stream frame
      //   issued before the release is accepted while the legacy interlude runs (legacy hosts
      //   stream every agent), and the fence still standing on the way back is what keeps that
      //   stale frame from repainting the cold transcript. Re-wanting the agent is the only thing
      //   that clears it, and `ensureCacheLoaded` is the single place that does that and reloads
      //   the transcript.
      for (const agentId of desired) visibilityCatchUpPending.add(agentId);
      acknowledged = deliveryMode === "legacy" && connected ? desired : [];
      notifyListeners();
      if (deliveryMode === "selective" && connected) void reconcileMembership();
      else if (connected) startAcknowledgedCatchUps();
    },
    recoverGap(agentId, cursor) {
      if (!isDesired(agentId)) return;
      startCatchUp(agentId, {
        request: planTimelineCatchUpAfter({ epoch: cursor.epoch, seq: cursor.endSeq }),
        supersede: true,
      });
    },
    dispose() {
      disposed = true;
      cancelMembershipRetry?.();
      cancelMembershipRetry = null;
      membershipNeedsRetry = false;
      membershipRetryDelayMs = undefined;
      sources.clear();
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      desired = [];
      ports.replaceDemandedAgentIds([]);
      acknowledged = [];
      recentlyViewedAgentIds = [];
      loadedCache.clear();
      cacheLoads.clear();
      releaseCandidates.clear();
      releasedTranscripts.clear();
      inFlightFetches.clear();
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      manualRetries.clear();
      notifyListeners();
      listeners.clear();
    },
    isTranscriptReleased(agentId) {
      // Only selective delivery evicts a transcript while the daemon keeps serving it; legacy
      // hosts stream every agent, so their responses are never stale.
      return deliveryMode === "selective" && releasedTranscripts.has(agentId);
    },
    noteTranscriptUpdate(agentId) {
      // A released transcript is only repopulated through the legacy hole in the fence. Registered
      // here and nowhere else: recording it under selective delivery would make `ensureCacheLoaded`
      // skip the `prepare` that re-adopts the agent after a release, leaving its display resident
      // but unpainted with no durable projection behind it.
      if (deliveryMode !== "legacy" || !releasedTranscripts.has(agentId)) return;
      loadedCache.add(agentId);
      releaseCandidates.add(agentId);
    },
    releaseInactiveTranscripts,
    retryVisibleAgentTimeline,
  };
}
