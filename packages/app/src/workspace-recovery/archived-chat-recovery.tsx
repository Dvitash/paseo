import { useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { FetchAgentTimelineCursor } from "@getpaseo/client/internal/daemon-client";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { toErrorMessage } from "@/utils/error-messages";
import { prepareSavedChatContinuation } from "./continue-saved-chat";

export interface ArchivedChatSelection {
  serverId: string;
  workspaceId: string;
  agentId: string;
}

export function ArchivedChatRecovery(input: ArchivedChatSelection & { disabled?: boolean }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"closed" | "history" | "continue">("closed");
  const [destinationId, setDestinationId] = useState<string | null>(null);
  const visible = mode !== "closed";
  const openGeneration = useRef(0);
  useEffect(
    () => () => {
      openGeneration.current += 1;
    },
    [],
  );
  const client = useHostRuntimeClient(input.serverId);
  const connected = useHostRuntimeIsConnected(input.serverId);
  const supported = useHostFeature(input.serverId, "savedAgentHistory");
  const supportsFork = useHostFeature(input.serverId, "agentForkContext");
  const workspaceMap = useSessionStore((s) => s.sessions[input.serverId]?.workspaces);
  const destinations = useMemo(
    () =>
      Array.from(workspaceMap?.values() ?? [])
        .filter((w) => w.id !== input.workspaceId && !w.archivingAt)
        .map((w) => ({
          id: w.id,
          value: w.id,
          label: `${w.projectDisplayName} / ${w.name}`,
          description: w.workspaceDirectory,
        })),
    [workspaceMap, input.workspaceId],
  );
  const destination = destinationId ? workspaceMap?.get(destinationId) : undefined;
  const selectedDisplay = destinations.find((w) => w.id === destinationId) ?? null;
  const queries = useQueryClient();
  const queryKey = ["savedAgentHistory", input.serverId, input.workspaceId, input.agentId];
  const history = useInfiniteQuery({
    queryKey,
    enabled: visible && supported && connected && Boolean(client),
    initialPageParam: undefined as FetchAgentTimelineCursor | undefined,
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ pageParam }) => {
      if (!client) throw new Error(t("common.errors.daemonClientUnavailable"));
      const page = await client.fetchAgentTimeline(input.agentId, {
        direction: pageParam ? "before" : "tail",
        cursor: pageParam,
        limit: 200,
        savedOnly: true,
      });
      if (page.error) throw new Error(page.error);
      if (pageParam && (page.reset || page.staleCursor)) {
        throw new Error(t("workspace.route.recovery.historyChanged"));
      }
      return page;
    },
    getNextPageParam: (page) => (page.hasOlder ? (page.startCursor ?? undefined) : undefined),
  });
  const entries = history.data?.pages.toReversed().flatMap((page) => page.entries) ?? [];
  const agent = history.data?.pages[0]?.agent;
  const continuation = useMutation({
    mutationFn: async (generation: number) => {
      if (!client || !connected || !supported || !supportsFork || !agent || !destination) {
        throw new Error(t("workspace.route.recovery.selectWorkspace"));
      }
      const draft = await prepareSavedChatContinuation({
        client,
        serverId: input.serverId,
        agentId: input.agentId,
        sourceWorkspaceId: input.workspaceId,
        agent,
        destination,
        missingAttachmentMessage: t("message.actions.forkFailed"),
      });
      if (generation !== openGeneration.current) return;
      const latest = useSessionStore
        .getState()
        .sessions[input.serverId]?.workspaces.get(destination.id);
      if (
        !latest ||
        latest.archivingAt ||
        latest.workspaceDirectory !== destination.workspaceDirectory
      ) {
        throw new Error(t("workspace.route.recovery.selectWorkspace"));
      }
      useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
        scopeKey: buildDraftWorkspaceAttachmentScopeKey(draft.draftId),
        attachments: [draft.attachment],
      });
      navigateToWorkspace({
        serverId: input.serverId,
        workspaceId: destination.id,
        target: {
          kind: "draft",
          draftId: draft.draftId,
          ...(draft.setup ? { setup: draft.setup } : {}),
        },
      });
      close();
    },
  });

  function close() {
    openGeneration.current += 1;
    setMode("closed");
  }
  function open(next: "history" | "continue") {
    openGeneration.current += 1;
    continuation.reset();
    void queries.resetQueries({ queryKey, exact: true });
    setMode(next);
  }
  function continueChat() {
    continuation.mutate(openGeneration.current);
  }

  // Older daemons resume providers during history fetches, so don't expose this action there.
  if (!supported) return null;
  const disabled = input.disabled || !connected || !client;
  return (
    <>
      <View style={styles.actions}>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onPress={() => open("history")}
          testID="view-saved-chat"
        >
          {t("workspace.route.recovery.viewSavedChat")}
        </Button>
        {supportsFork ? (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onPress={() => open("continue")}
            testID="continue-saved-chat"
          >
            {t("workspace.route.recovery.continueElsewhere")}
          </Button>
        ) : null}
      </View>
      <AdaptiveModalSheet
        visible={visible}
        onClose={close}
        desktopMaxWidth={840}
        header={{
          title: t(
            mode === "continue"
              ? "workspace.route.recovery.continueElsewhere"
              : "workspace.route.recovery.savedChatTitle",
          ),
        }}
        testID="saved-chat-dialog"
      >
        <View style={styles.body}>
          <Text style={styles.muted}>{t("workspace.route.recovery.savedChatNotice")}</Text>
          {!connected ? (
            <Text style={styles.error}>{t("common.errors.daemonClientDisconnected")}</Text>
          ) : null}
          {mode === "continue" ? (
            <>
              <SelectField
                label={t("workspace.route.recovery.destinationWorkspace")}
                value={destinationId}
                selectedDisplay={selectedDisplay}
                options={destinations}
                onChange={setDestinationId}
                placeholder={t("workspace.route.recovery.selectWorkspace")}
                emptyText={t("workspace.route.recovery.noWorkspaces")}
                disabled={continuation.isPending || !connected}
                searchable
                triggerTestID="saved-chat-destination"
              />
              {continuation.error ? (
                <Text style={styles.error} testID="saved-chat-continuation-error">
                  {toErrorMessage(continuation.error)}
                </Text>
              ) : null}
              <Button
                disabled={!agent || !selectedDisplay || continuation.isPending || !connected}
                onPress={continueChat}
                testID="confirm-saved-chat-continuation"
              >
                {t(
                  continuation.isPending
                    ? "common.loading"
                    : "workspace.route.recovery.continueAction",
                )}
              </Button>
            </>
          ) : null}
          {history.isFetching ? <Text style={styles.muted}>{t("common.loading")}</Text> : null}
          {history.error ? (
            <>
              <Text style={styles.error} testID="saved-chat-history-error">
                {toErrorMessage(history.error)}
              </Text>
              <Button
                size="sm"
                variant="outline"
                disabled={!connected}
                onPress={() => {
                  void queries.resetQueries({ queryKey, exact: true });
                }}
              >
                {t("common.actions.retry")}
              </Button>
            </>
          ) : null}
          {mode === "history" && history.hasNextPage ? (
            <Button
              size="sm"
              variant="outline"
              disabled={history.isFetching || !connected}
              onPress={() => {
                void history.fetchNextPage();
              }}
            >
              {t("workspace.route.recovery.loadOlder")}
            </Button>
          ) : null}
          {history.isSuccess && entries.length === 0 ? (
            <Text style={styles.muted}>{t("workspace.route.recovery.emptyHistory")}</Text>
          ) : null}
          {mode === "history"
            ? entries.map((entry) => (
                <SavedHistoryEntry key={`${entry.seqStart}:${entry.seqEnd}`} item={entry.item} />
              ))
            : null}
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

function SavedHistoryEntry({ item }: { item: AgentTimelineItem }) {
  const [expanded, setExpanded] = useState(false);
  if (item.type === "tool_call") {
    return (
      <View style={styles.entry}>
        <Button
          size="sm"
          variant="ghost"
          onPress={() => setExpanded(!expanded)}
        >{`${item.name} · ${item.status}`}</Button>
        {expanded ? (
          <Text selectable style={styles.text}>
            {JSON.stringify(item, null, 2)}
          </Text>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.entry}>
      <Text style={styles.muted}>{item.type.replaceAll("_", " ")}</Text>
      <Text selectable style={styles.text}>
        {"text" in item && typeof item.text === "string"
          ? item.text
          : JSON.stringify(item, null, 2)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  body: { gap: theme.spacing[4], padding: theme.spacing[4] },
  entry: {
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  text: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    lineHeight: Math.round(theme.fontSize.base * 1.5),
  },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.base },
}));
