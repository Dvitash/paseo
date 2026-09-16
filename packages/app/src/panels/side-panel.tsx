import { useStableEvent } from "@/hooks/use-stable-event";
import type { SideChatAction } from "@getpaseo/protocol/side";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Text, View, Modal, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotMessageSquare } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SideChatReference } from "@getpaseo/protocol/side";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { useIsCompactFormFactor } from "@/constants/layout";
import { AssistantFileLinkResolverProvider } from "@/assistant-file-links/provider";
import { Button } from "@/components/ui/button";
import { useSideChat } from "./side/use-side-chat";
import { SideHeader } from "./side/header";
import { SideTranscript } from "./side/transcript";
import { SideComposer } from "./side/composer";
import { SIDE_PHASE_LABELS, useSideWorkspaceStore } from "./side/state";
import { styles } from "./side/styles";
import { useSideNavigation } from "./side/navigation";
import { sideSessionKey } from "./side/state";
import {
  SIDE_CHAT_TEST_IDS,
  resolveSelectedMainAgent,
  type SelectedMainAgent,
} from "./side-panel-state";

export { SteeringProposalCard } from "./side/proposal";
export {
  SIDE_CHAT_TEST_IDS,
  resolveEffectiveSideProvider,
  resolveSelectedMainAgent,
  type SelectedMainAgent,
} from "./side-panel-state";
const ThemedBotMessageSquare = withUnistyles(BotMessageSquare);

export function useSelectedMainAgentFromLayout({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}): SelectedMainAgent {
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const layout = useWorkspaceLayoutStore((state) =>
    workspaceKey ? (state.layoutByWorkspace[workspaceKey] ?? null) : null,
  );
  const explorerSidebarPaneId = useWorkspaceLayoutStore((state) =>
    workspaceKey ? (state.explorerSidebarPaneIdByWorkspace[workspaceKey] ?? null) : null,
  );

  const initialResolution = useMemo(
    () => resolveSelectedMainAgent({ layout, explorerSidebarPaneId }),
    [explorerSidebarPaneId, layout],
  );

  const remembered = useSideWorkspaceStore((state) =>
    workspaceKey ? state.lastMain[workspaceKey] : null,
  );
  const readingSidebar = layout?.focusedPaneId === explorerSidebarPaneId;
  const resolvedId =
    (readingSidebar || !initialResolution.mainAgentId) && remembered
      ? remembered
      : initialResolution.mainAgentId;
  useEffect(() => {
    if (workspaceKey && !readingSidebar && initialResolution.mainAgentId)
      useSideWorkspaceStore.getState().rememberMain(workspaceKey, initialResolution.mainAgentId);
  }, [workspaceKey, readingSidebar, initialResolution.mainAgentId]);
  const agent = useSessionStore((state) =>
    resolvedId ? (state.sessions[serverId]?.agents.get(resolvedId) ?? null) : null,
  );

  return useMemo(
    () => ({
      mainAgentId: resolvedId,
      mainAgentTitle: agent?.title ?? null,
      mainAgentProvider: agent?.provider ?? null,
    }),
    [agent?.title, agent?.provider, resolvedId],
  );
}

interface SideChatViewProps {
  serverId: string;
  mainAgentId: string;
  mainAgentTitle: string | null;
  mainAgentProvider: string | null;
  client: DaemonClient | null;
  isActive: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onOpenMain?: () => void;
  onOpenMainAt?: (seq: number, epoch: string) => void;
  onOpenSource?: (reference: SideChatReference) => void;
}
export function SideChatView({
  serverId,
  mainAgentId,
  mainAgentTitle,
  mainAgentProvider,
  client,
  isActive,
  pinned,
  onTogglePin,
  onOpenMain,
  onOpenMainAt,
  onOpenSource,
}: SideChatViewProps) {
  const chat = useSideChat({ serverId, mainAgentId, mainAgentProvider, client, isActive });
  const [reference, setReference] = useState<SideChatReference | null>(null);
  const title = mainAgentTitle ?? mainAgentId;
  const running = chat.snapshot?.status === "running";
  const phase = chat.snapshot?.phase ?? "reading_context";
  const closeSource = useCallback(() => setReference(null), []);
  const retrySend = useStableEvent(() => {
    void chat.send("question", true);
  });
  const discardSend = useStableEvent(() => chat.updateDraft({ submission: null }));
  const stop = useStableEvent(() => {
    void chat.stop();
  });
  const send = useStableEvent((action?: SideChatAction) => {
    void chat.send(action);
  });
  const openSource = useStableEvent(() => {
    if (reference) onOpenSource?.(reference);
    setReference(null);
  });
  return (
    <View style={styles.container} testID={SIDE_CHAT_TEST_IDS.view}>
      <SideHeader
        serverId={serverId}
        snapshot={chat.snapshot}
        client={client}
        mainAgentId={mainAgentId}
        mainAgentTitle={title}
        provider={chat.provider}
        draft={chat.draft}
        updateDraft={chat.updateDraft}
        isActive={isActive}
        pinned={pinned}
        onTogglePin={onTogglePin}
        onOpenMain={onOpenMain}
      />
      {chat.error ? (
        <View style={styles.notice} testID={SIDE_CHAT_TEST_IDS.errorBanner}>
          <Text style={styles.error} accessibilityRole="alert">
            {chat.error}
          </Text>
          <Button size="sm" variant="ghost" onPress={chat.refresh}>
            Reconnect / refresh
          </Button>
        </View>
      ) : null}
      {chat.snapshot ? (
        <SideTranscript
          key={`${chat.sessionKey}:${chat.snapshot.conversationId}`}
          snapshot={chat.snapshot}
          sessionKey={chat.sessionKey}
          mainAgentTitle={title}
          client={client}
          submission={chat.draft.submission}
          onRetry={retrySend}
          onDiscard={discardSend}
          onOpenReference={setReference}
          onOpenMainAt={onOpenMainAt}
        />
      ) : (
        <View style={styles.center}>
          <Text style={styles.muted}>Connecting to Side…</Text>
        </View>
      )}
      {running ? (
        <View style={[styles.spread, styles.notice]} testID={SIDE_CHAT_TEST_IDS.runningIndicator}>
          <View style={styles.grow}>
            <Text style={styles.muted} accessibilityLiveRegion="polite">
              {SIDE_PHASE_LABELS[phase]}
            </Text>
            {chat.snapshot?.activity ? (
              <Text selectable style={styles.muted}>
                {chat.snapshot.activity}
              </Text>
            ) : null}
          </View>
          <Button
            size="sm"
            variant="outline"
            loading={chat.isStopping}
            disabled={chat.isStopping}
            onPress={stop}
            testID={SIDE_CHAT_TEST_IDS.stopButton}
          >
            Stop
          </Button>
        </View>
      ) : null}
      <SideComposer
        draft={chat.draft}
        running={running}
        canSend={Boolean(client?.isConnected && chat.snapshot && chat.provider)}
        updateDraft={chat.updateDraft}
        send={send}
        onOpenReference={setReference}
      />
      <Modal visible={reference !== null} onRequestClose={closeSource} animationType="slide">
        <SafeAreaView style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>{reference?.label}</Text>
            <Text style={styles.muted}>Quoted when attached; the source may have changed.</Text>
          </View>
          <ScrollView contentContainerStyle={styles.messages}>
            <Text selectable style={styles.text}>
              {reference?.text}
            </Text>
          </ScrollView>
          <View style={[styles.row, styles.notice]}>
            <Button onPress={closeSource}>Close</Button>
            {onOpenSource ? (
              <Button variant="secondary" onPress={openSource}>
                Open source
              </Button>
            ) : null}
          </View>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

export function SidePanel() {
  const pane = usePaneContext();
  const { serverId, workspaceId } = pane;
  const isActive = useRetainedPanelActive();
  const isCompact = useIsCompactFormFactor();
  const client = useHostRuntimeClient(serverId);
  const selected = useSelectedMainAgentFromLayout({ serverId, workspaceId });
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  const pinnedId = useSideWorkspaceStore((state) =>
    workspaceKey ? (state.pins[workspaceKey] ?? null) : null,
  );
  const mainAgentId = pinnedId ?? selected.mainAgentId;
  const agent = useSessionStore((state) =>
    mainAgentId ? state.sessions[serverId]?.agents.get(mainAgentId) : null,
  );
  const openMain = useCallback(() => {
    if (!workspaceKey || !mainAgentId) return;
    useWorkspaceLayoutStore
      .getState()
      .openTab({ workspaceKey, target: { kind: "agent", agentId: mainAgentId }, intent: "reveal" });
    if (isCompact) usePanelStore.getState().showMobileAgent();
  }, [workspaceKey, mainAgentId, isCompact]);
  const openMainAt = useCallback(
    (seq: number, epoch: string) => {
      if (!mainAgentId) return;
      useSideNavigation.getState().request(sideSessionKey(serverId, mainAgentId), seq, epoch);
      openMain();
    },
    [mainAgentId, serverId, openMain],
  );
  const openSource = useCallback(
    (reference: SideChatReference) => {
      if (reference.path)
        pane.openFileInWorkspace({ location: { path: reference.path }, disposition: "main" });
      else openMain();
    },
    [pane, openMain],
  );
  const togglePin = useStableEvent(() => {
    if (workspaceKey)
      useSideWorkspaceStore.getState().pin(workspaceKey, pinnedId ? null : mainAgentId);
  });
  const openWorkspaceFile = useCallback<
    NonNullable<
      React.ComponentProps<typeof AssistantFileLinkResolverProvider>["onOpenWorkspaceFile"]
    >
  >((target, disposition) => pane.openFileInWorkspace({ location: target, disposition }), [pane]);
  if (client && client.getLastServerInfoMessage()?.features?.sideChatV2 !== true) {
    return (
      <View style={styles.center} testID={SIDE_CHAT_TEST_IDS.capabilityMissing}>
        <Text style={styles.muted}>Update the host to use this version of Side chat.</Text>
      </View>
    );
  }
  if (!mainAgentId) {
    return (
      <View style={styles.center} testID={SIDE_CHAT_TEST_IDS.emptyState}>
        <Text style={styles.title}>No main agent selected</Text>
        <Text style={styles.muted}>Select an agent tab to ask Side about its work.</Text>
      </View>
    );
  }
  return (
    <AssistantFileLinkResolverProvider
      client={client}
      serverId={serverId}
      workspaceRoot={agent?.cwd}
      onOpenWorkspaceFile={openWorkspaceFile}
    >
      <SideChatView
        key={`${serverId}:${mainAgentId}`}
        serverId={serverId}
        mainAgentId={mainAgentId}
        mainAgentTitle={agent?.title ?? (pinnedId ? mainAgentId : selected.mainAgentTitle)}
        mainAgentProvider={agent?.provider ?? (pinnedId ? null : selected.mainAgentProvider)}
        client={client}
        isActive={isActive}
        pinned={Boolean(pinnedId)}
        onTogglePin={togglePin}
        onOpenMain={openMain}
        onOpenMainAt={openMainAt}
        onOpenSource={openSource}
      />
    </AssistantFileLinkResolverProvider>
  );
}
export const sidePresentation = {
  label: (t) => t("panels.side.label", { defaultValue: "Side" }),
  subtitle: (t) => t("panels.side.subtitle", { defaultValue: "Side chat" }),
  tooltip: (t) => t("panels.side.tooltip", { defaultValue: "Side chat linked to active agent" }),
  icon: ThemedBotMessageSquare,
} satisfies PanelPresentation;
export const sidePanelRegistration = definePanel("side", {
  component: SidePanel,
  presentation: sidePresentation,
});
