import { useEffect, useRef, useState, type RefObject } from "react";
import { create } from "zustand";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelinePromptJump } from "@/timeline/timeline-sync-plan";
import type { StreamItem } from "@/types/stream";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import { sideSessionKey } from "./state";

interface SourceJump {
  id: string;
  seq: number;
  epoch: string;
}
interface SideNavigation {
  requests: Record<string, SourceJump>;
  request: (key: string, seq: number, epoch: string) => void;
  complete: (key: string, id: string) => void;
}
export const useSideNavigation = create<SideNavigation>((set) => ({
  requests: {},
  request: (key, seq, epoch) =>
    set((state) => ({
      requests: { ...state.requests, [key]: { id: crypto.randomUUID(), seq, epoch } },
    })),
  complete: (key, id) =>
    set((state) => {
      if (state.requests[key]?.id !== id) return state;
      const requests = { ...state.requests };
      delete requests[key];
      return { requests };
    }),
}));
interface SideSourceJumpInput {
  serverId: string | undefined;
  agentId: string;
  epoch: string | null;
  items: readonly StreamItem[];
  head: readonly StreamItem[] | undefined;
  visibleItemIds: ReadonlySet<string>;
  reveal: (itemId: string) => boolean;
  viewportRef: RefObject<StreamViewportHandle | null>;
  active: boolean;
  onError: () => void;
}
export function useSideSourceJump({
  serverId,
  agentId,
  epoch,
  items,
  head,
  visibleItemIds,
  reveal,
  viewportRef,
  active,
  onError,
}: SideSourceJumpInput): void {
  const key = sideSessionKey(serverId ?? "", agentId);
  const request = useSideNavigation((state) => state.requests[key]);
  const fetching = useRef<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
  useEffect(() => {
    if (!request || !serverId || !active || !epoch) return;
    const complete = () => useSideNavigation.getState().complete(key, request.id);
    if (request.epoch !== epoch) {
      complete();
      onError();
      return;
    }
    const item =
      items.find((row) => row.timelineCursor?.seq === request.seq) ??
      head?.find((row) => row.timelineCursor?.seq === request.seq);
    if (item) {
      if (!visibleItemIds.has(item.id) && reveal(item.id)) return;
      if (viewportRef.current?.scrollToMessage) viewportRef.current.scrollToMessage(item.id);
      else onError();
      complete();
      return;
    }
    if (settled === request.id) {
      complete();
      onError();
      return;
    }
    if (fetching.current === request.id) return;
    fetching.current = request.id;
    void getHostRuntimeStore()
      .fetchAgentTimeline(serverId, agentId, planTimelinePromptJump({ epoch, seq: request.seq }))
      .catch(() => {
        complete();
        onError();
      })
      .finally(() => setSettled(request.id));
  }, [
    request,
    serverId,
    agentId,
    active,
    epoch,
    key,
    items,
    head,
    visibleItemIds,
    reveal,
    viewportRef,
    onError,
    settled,
  ]);
}
