import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SideChatAction, SideChatSnapshot } from "@getpaseo/protocol/side";
import { useReplicaQuery } from "@/data/query";
import { isWeb } from "@/constants/platform";
import { toErrorMessage } from "@/utils/error-messages";
import {
  EMPTY_SIDE_DRAFT,
  sideSessionKey,
  useSideWorkspaceStore,
  type SideDraft,
  type SideSubmission,
} from "./state";
import { resolveEffectiveSideProvider } from "../side-panel-state";

interface SideChatInput {
  client: DaemonClient | null;
  serverId: string;
  mainAgentId: string;
  mainAgentProvider: string | null;
  isActive: boolean;
}
export function useSideChat({
  client,
  serverId,
  mainAgentId,
  mainAgentProvider,
  isActive,
}: SideChatInput) {
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["sideChat", serverId, mainAgentId], [serverId, mainAgentId]);
  const sessionKey = sideSessionKey(serverId, mainAgentId);
  const draft = useSideWorkspaceStore((state) => state.drafts[sessionKey] ?? EMPTY_SIDE_DRAFT);
  const query = useReplicaQuery<SideChatSnapshot>({
    queryKey,
    pushEvent: "agent.side.changed",
    enabled: false,
  });
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isStopping, setStopping] = useState(false);
  const inFlight = useRef(new Set<string>());
  const snapshot = query.data;
  const provider = resolveEffectiveSideProvider({
    activeSideProvider: snapshot?.sideAgentId ? snapshot.provider : null,
    selectedProvider: draft.provider,
    mainAgentProvider,
    supportedProviders: snapshot?.supportedProviders,
  });

  useEffect(() => {
    if (!client || !isActive) return;
    const unsubscribe = client.subscribeSideChat(
      mainAgentId,
      (next) => {
        queryClient.setQueryData(queryKey, next);
        useSideWorkspaceStore.getState().reconcile(sessionKey, next);
        setConnectionError(null);
      },
      (error) => setConnectionError(error.message),
    );
    const unsubscribeConnection = client.subscribeConnectionStatus((status) => {
      if (status.status !== "connected")
        setConnectionError("Disconnected. Reconnecting to the host…");
    });
    const refresh = () => {
      void client.refreshSideChat(mainAgentId);
    };
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    const visible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    if (isWeb) {
      window.addEventListener("focus", refresh);
      window.addEventListener("pageshow", refresh);
      document.addEventListener("visibilitychange", visible);
    }
    return () => {
      unsubscribe();
      unsubscribeConnection();
      appState.remove();
      if (isWeb) {
        window.removeEventListener("focus", refresh);
        window.removeEventListener("pageshow", refresh);
        document.removeEventListener("visibilitychange", visible);
      }
    };
  }, [client, mainAgentId, sessionKey, queryClient, queryKey, isActive]);

  const updateDraft = useCallback(
    (patch: Partial<SideDraft>) => {
      useSideWorkspaceStore.getState().updateDraft(sessionKey, patch);
    },
    [sessionKey],
  );

  const send = useCallback(
    async (action: SideChatAction = "question", retry = false) => {
      if (!client || !provider) return;
      const store = useSideWorkspaceStore.getState();
      const current = store.drafts[sessionKey] ?? EMPTY_SIDE_DRAFT;
      if (!retry && current.submission) return;
      const prompts = {
        status: "Status update",
        review: "Review current changes",
        steer: "Draft a steer from our discussion",
        question: current.text.trim(),
      };
      const submission: SideSubmission =
        retry && current.submission
          ? { ...current.submission, state: "sending", error: null }
          : {
              id: crypto.randomUUID(),
              text: prompts[action],
              action,
              references: current.references,
              provider,
              model: current.model,
              state: "sending",
              error: null,
            };
      if (!submission.text || inFlight.current.has(submission.id)) return;
      inFlight.current.add(submission.id);
      store.updateDraft(sessionKey, { submission });
      setActionError(null);
      try {
        const next = await client.sendSideChat(mainAgentId, submission.text, {
          provider: submission.provider,
          model: submission.model ?? undefined,
          clientMessageId: submission.id,
          action: submission.action,
          references: submission.references,
        });
        useSideWorkspaceStore.getState().reconcile(sessionKey, next);
        await client.refreshSideChat(mainAgentId);
      } catch (error) {
        const latest = useSideWorkspaceStore.getState().drafts[sessionKey];
        if (latest?.submission?.id === submission.id) {
          useSideWorkspaceStore.getState().updateDraft(sessionKey, {
            submission: { ...submission, state: "failed", error: toErrorMessage(error) },
          });
        }
      } finally {
        inFlight.current.delete(submission.id);
      }
    },
    [client, mainAgentId, provider, sessionKey],
  );

  const stop = useCallback(async () => {
    if (!client || isStopping) return;
    setStopping(true);
    setActionError(null);
    try {
      await client.stopSideChat(mainAgentId);
      await client.refreshSideChat(mainAgentId);
    } catch (error) {
      setActionError(toErrorMessage(error));
    } finally {
      setStopping(false);
    }
  }, [client, mainAgentId, isStopping]);

  const refresh = useCallback(() => {
    void client?.refreshSideChat(mainAgentId);
  }, [client, mainAgentId]);
  return {
    snapshot,
    sessionKey,
    draft,
    provider,
    updateDraft,
    send,
    stop,
    refresh,
    isStopping,
    error: actionError ?? connectionError ?? snapshot?.error ?? null,
  };
}
