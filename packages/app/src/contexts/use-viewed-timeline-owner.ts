import { useCallback, useEffect, useRef, type RefObject } from "react";
import { useAppVisible } from "@/hooks/use-app-visible";
import {
  createSetAgentInitializing,
  refreshAgentInitializationTimeout,
} from "@/hooks/use-agent-initialization";
import { planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import {
  consumeForcedTimelineTailReplacement,
  type TimelineDeliveryMode,
  type TimelineResponsePayload,
  type ViewedTimelineOwner,
} from "@/timeline/viewed-timeline-sync";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { selectAgentTimelineState, useSessionStore } from "@/stores/session-store";
import {
  getInitKey,
  getInitDeferred,
  createInitDeferred,
  rejectInitDeferred,
} from "@/utils/agent-initialization";

// COMPAT(selectiveAgentTimeline): added in v0.1.106, remove after 2027-01-12.
export function getTimelineDeliveryMode(selectiveAgentTimeline?: boolean): TimelineDeliveryMode {
  return selectiveAgentTimeline ? "selective" : "legacy";
}

export interface UseViewedTimelineOwnerInput {
  serverId: string;
  client: DaemonClient;
  isConnected: boolean;
}

export interface ViewedTimelineOwnerHandle {
  viewedTimelineSyncRef: RefObject<ViewedTimelineOwner | null>;
  applyTimelineResponse: (payload: TimelineResponsePayload) => void;
}

/**
 * Owns the viewed-timeline owner lifecycle for one host: creation, connection and
 * visibility propagation, and disposal. Every freshly created owner is initialized
 * with the connection and visibility state current at its creation — a client
 * replacement that keeps both booleans unchanged must still produce a connected,
 * active owner, so initialization happens at creation instead of relying on the
 * `isConnected`/`isAppVisible` effects having a change to observe.
 */
export function useViewedTimelineOwner(
  input: UseViewedTimelineOwnerInput,
): ViewedTimelineOwnerHandle {
  const { serverId, client, isConnected } = input;
  const isAppVisible = useAppVisible();
  const setInitializingAgents = useSessionStore((state) => state.setInitializingAgents);
  const setViewedTimelineSync = useSessionStore((state) => state.setViewedTimelineSync);
  const viewedTimelineSyncRef = useRef<ViewedTimelineOwner | null>(null);
  const forcedTimelineTailReplacements = useRef(new Set<string>());

  const applyTimelineResponse = useCallback((receivedPayload: TimelineResponsePayload) => {
    const payload = consumeForcedTimelineTailReplacement(
      receivedPayload,
      forcedTimelineTailReplacements.current,
    );
    const owner = viewedTimelineSyncRef.current;
    if (!owner) throw new Error("Viewed timeline owner is unavailable");
    owner.applyTimelineResponse(payload);
  }, []);

  useEffect(() => {
    const setAgentInitializing = createSetAgentInitializing(serverId, setInitializingAgents);
    const initialDeliveryMode = getTimelineDeliveryMode(
      client.getLastServerInfoMessage()?.features?.selectiveAgentTimeline,
    );
    const sync = getHostRuntimeStore().createViewedTimelineOwner(serverId, {
      initialDeliveryMode,
      setSubscription: (agentIds) => client.setAgentTimelineSubscription(agentIds),
      readCursor: (agentId) => {
        const timeline = selectAgentTimelineState(
          useSessionStore.getState().sessions[serverId],
          agentId,
        );
        return timeline.status === "synced" && timeline.range
          ? { epoch: timeline.range.epoch, endSeq: timeline.range.endSeq }
          : undefined;
      },
      fetchPage: async (agentId, request) => {
        const session = useSessionStore.getState().sessions[serverId];
        const initKey = getInitKey(serverId, agentId);
        const shouldInitialize = selectAgentTimelineState(session, agentId).status !== "synced";
        if (shouldInitialize) {
          if (!getInitDeferred(initKey)) {
            const deferred = createInitDeferred(initKey, request.direction ?? "tail");
            void deferred.promise.catch(() => undefined);
          }
          refreshAgentInitializationTimeout({
            key: initKey,
            agentId,
            setAgentInitializing,
          });
          setAgentInitializing(agentId, true);
        }
        try {
          const page = await getHostRuntimeStore().fetchAgentTimeline(serverId, agentId, request);
          if (shouldInitialize && getInitDeferred(initKey)) {
            refreshAgentInitializationTimeout({ key: initKey, agentId, setAgentInitializing });
          }
          return page;
        } catch (error) {
          if (shouldInitialize) {
            setAgentInitializing(agentId, false);
            rejectInitDeferred(initKey, error instanceof Error ? error : new Error(String(error)));
          }
          throw error;
        }
      },
      fetchLatestTail: async (agentId) => {
        forcedTimelineTailReplacements.current.add(agentId);
        try {
          return await getHostRuntimeStore().fetchAgentTimeline(
            serverId,
            agentId,
            planTimelineTailFetch(),
          );
        } finally {
          forcedTimelineTailReplacements.current.delete(agentId);
        }
      },
      reportError: (error) => {
        console.warn("[Session] viewed timeline synchronization failed", { serverId, error });
      },
      schedule: (task, delayMs) => {
        const timeout = setTimeout(task, delayMs);
        return () => clearTimeout(timeout);
      },
    });
    viewedTimelineSyncRef.current = sync;
    setViewedTimelineSync(serverId, sync);
    // A replacement owner inherits the live connection and visibility state; neither
    // boolean is guaranteed to change again after the swap.
    sync.setConnected(isConnected);
    sync.setActive(isAppVisible);

    return () => {
      if (viewedTimelineSyncRef.current === sync) {
        viewedTimelineSyncRef.current = null;
      }
      setViewedTimelineSync(serverId, null);
      sync.dispose();
    };
    // Connection and visibility are deliberately read once at creation: their effects
    // below keep the surviving owner current for later transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, serverId, setInitializingAgents, setViewedTimelineSync]);

  useEffect(() => {
    viewedTimelineSyncRef.current?.setActive(isAppVisible);
  }, [isAppVisible]);

  useEffect(() => {
    viewedTimelineSyncRef.current?.setConnected(isConnected);
  }, [isConnected]);

  return { viewedTimelineSyncRef, applyTimelineResponse };
}
