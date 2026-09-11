import React, { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ScrollView,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { useTranslation } from "react-i18next";
import { BotMessageSquare, CircleAlert, Check, ChevronDown } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useQueryClient } from "@tanstack/react-query";
import { useFetchQuery } from "@/data/query";
import type { SideChatSnapshot, SideChatSendOptions } from "@getpaseo/protocol/side";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSessionStore } from "@/stores/session-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { toErrorMessage } from "@/utils/error-messages";
import type { Theme } from "@/styles/theme";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import {
  SIDE_CHAT_TEST_IDS,
  SIDE_STATUS_UPDATE_PROMPT,
  resolveEffectiveSideProvider,
  resolveSelectedMainAgent,
  type SelectedMainAgent,
} from "./side-panel-state";

export {
  SIDE_CHAT_TEST_IDS,
  resolveEffectiveSideProvider,
  resolveSelectedMainAgent,
  type SelectedMainAgent,
} from "./side-panel-state";

const ThemedBotMessageSquare = withUnistyles(BotMessageSquare);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCheck = withUnistyles(Check);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentColorMapping = (theme: Theme) => ({ color: theme.colors.primary });
const errorColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const successColorMapping = (theme: Theme) => ({ color: theme.colors.success });

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

  const agent = useSessionStore((state) =>
    initialResolution.mainAgentId
      ? (state.sessions[serverId]?.agents.get(initialResolution.mainAgentId) ?? null)
      : null,
  );

  return useMemo(
    () => resolveSelectedMainAgent({ layout, explorerSidebarPaneId, agent }),
    [agent, explorerSidebarPaneId, layout],
  );
}

interface SteeringProposalCardProps {
  proposal: string;
  mainAgentId: string;
  client: DaemonClient | null;
}

export function SteeringProposalCard({ proposal, mainAgentId, client }: SteeringProposalCardProps) {
  const { t } = useTranslation();
  const [editedText, setEditedText] = useState(proposal);
  const [steerStatus, setSteerStatus] = useState<"idle" | "pending" | "success" | "failure">(
    "idle",
  );
  const [steerError, setSteerError] = useState<string | null>(null);

  const handleTextChange = useCallback(
    (text: string) => {
      setEditedText(text);
      if (steerStatus !== "idle") setSteerStatus("idle");
      if (steerError) setSteerError(null);
    },
    [steerError, steerStatus],
  );

  const handleSendToMain = useCallback(async () => {
    const textToSend = editedText.trim();
    if (!client || !mainAgentId || !textToSend || steerStatus === "pending") return;
    const capturedAgentId = mainAgentId;
    setSteerStatus("pending");
    setSteerError(null);
    try {
      await client.sendAgentMessage(capturedAgentId, textToSend, {
        activeTurnBehavior: "steer",
      });
      setSteerStatus("success");
    } catch (err) {
      setSteerStatus("failure");
      setSteerError(toErrorMessage(err));
    }
  }, [client, editedText, mainAgentId, steerStatus]);

  let actionElement: ReactNode = null;
  if (steerStatus === "success") {
    actionElement = (
      <View style={styles.steerSuccessRow}>
        <ThemedCheck size={14} uniProps={successColorMapping} />
        <Text style={styles.steerSuccessText}>
          {t("panels.side.sentToMain", { defaultValue: "Sent to main agent" })}
        </Text>
      </View>
    );
  } else {
    actionElement = (
      <Button
        size="sm"
        variant={steerStatus === "failure" ? "outline" : "secondary"}
        loading={steerStatus === "pending"}
        disabled={!editedText.trim() || steerStatus === "pending"}
        onPress={handleSendToMain}
        testID={SIDE_CHAT_TEST_IDS.steeringSendButton}
      >
        {steerStatus === "failure"
          ? t("panels.side.retry", { defaultValue: "Retry" })
          : t("panels.side.sendToMain", { defaultValue: "Send to main" })}
      </Button>
    );
  }

  return (
    <View style={styles.steeringCard} testID={SIDE_CHAT_TEST_IDS.steeringCard}>
      <View style={styles.steeringHeader}>
        <ThemedBotMessageSquare size={14} uniProps={accentColorMapping} />
        <Text style={styles.steeringTitle}>
          {t("panels.side.proposedSteering", { defaultValue: "Proposed Steering to Main" })}
        </Text>
      </View>
      <AdaptiveTextInput
        style={styles.steeringInput}
        multiline
        initialValue={proposal}
        onChangeText={handleTextChange}
        placeholder={t("panels.side.proposedSteering", {
          defaultValue: "Proposed Steering to Main",
        })}
        testID={SIDE_CHAT_TEST_IDS.steeringInput}
      />
      {steerStatus === "failure" && steerError ? (
        <View style={styles.steerErrorContainer}>
          <Text style={styles.errorText}>{steerError}</Text>
        </View>
      ) : null}
      <View style={styles.steeringActions}>{actionElement}</View>
    </View>
  );
}

function useSideComposer({
  client,
  mainAgentId,
  queryKey,
  activeSideProvider,
  mainAgentProvider,
  supportedProviders,
}: {
  client: DaemonClient | null;
  mainAgentId: string;
  queryKey: readonly string[];
  activeSideProvider: string | null;
  mainAgentProvider: string | null;
  supportedProviders: readonly string[];
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const effectiveProvider = useMemo(
    () =>
      resolveEffectiveSideProvider({
        activeSideProvider,
        mainAgentProvider,
        supportedProviders: supportedProviders as string[],
      }),
    [activeSideProvider, mainAgentProvider, supportedProviders],
  );

  const isMainProviderSupported = mainAgentProvider
    ? supportedProviders.includes(mainAgentProvider)
    : true;

  const sendMessage = useCallback(
    async (text: string, options?: { clearDraft?: boolean }) => {
      if (!text || !client || isSending) return;
      const capturedAgentId = mainAgentId;
      const sendOptions: SideChatSendOptions = {};
      if (effectiveProvider) {
        sendOptions.provider = effectiveProvider;
      }
      setIsSending(true);
      setSendError(null);
      try {
        const nextSnapshot = await client.sendSideChat(capturedAgentId, text, sendOptions);
        queryClient.setQueryData(queryKey, nextSnapshot);
        if (options?.clearDraft) {
          setDraft("");
          setResetKey((prev) => prev + 1);
        }
      } catch (err) {
        setSendError(toErrorMessage(err));
      } finally {
        setIsSending(false);
      }
    },
    [client, effectiveProvider, isSending, mainAgentId, queryClient, queryKey],
  );

  const handleSend = useCallback(() => {
    void sendMessage(draft.trim(), { clearDraft: true });
  }, [draft, sendMessage]);

  const handleStatusUpdate = useCallback(() => {
    void sendMessage(SIDE_STATUS_UPDATE_PROMPT);
  }, [sendMessage]);

  const handleStop = useCallback(async () => {
    if (!client || isStopping) return;
    const capturedAgentId = mainAgentId;
    setIsStopping(true);
    try {
      const nextSnapshot = await client.stopSideChat(capturedAgentId);
      queryClient.setQueryData(queryKey, nextSnapshot);
    } catch (err) {
      setSendError(toErrorMessage(err));
    } finally {
      setIsStopping(false);
    }
  }, [client, isStopping, mainAgentId, queryClient, queryKey]);

  const handleDraftChange = useCallback(
    (text: string) => {
      setDraft(text);
      if (sendError) setSendError(null);
    },
    [sendError],
  );

  const handleSelectProvider = useCallback((provider: string) => {
    setSelectedProvider(provider);
  }, []);

  return {
    draft,
    sendError,
    isSending,
    isStopping,
    selectedProvider,
    effectiveProvider,
    isMainProviderSupported,
    resetKey,
    handleSend,
    handleStatusUpdate,
    handleStop,
    handleDraftChange,
    handleSelectProvider,
  };
}
interface ProviderMenuItemProps {
  provider: string;
  onSelect: (provider: string) => void;
}

const ProviderMenuItem = React.memo(function ProviderMenuItem({
  provider,
  onSelect,
}: ProviderMenuItemProps) {
  const handleSelect = useCallback(() => {
    onSelect(provider);
  }, [onSelect, provider]);

  return (
    <DropdownMenuItem onSelect={handleSelect} testID={`side-provider-option-${provider}`}>
      {provider}
    </DropdownMenuItem>
  );
});

interface SideChatHeaderProps {
  mainAgentTitle: string | null;
  mainAgentId: string;
  isStarted: boolean;
  activeSideProvider: string | null;
  supportedProviders: readonly string[];
  effectiveProvider: string | null;
  onSelectProvider: (provider: string) => void;
}

function SideChatHeader({
  mainAgentTitle,
  mainAgentId,
  isStarted,
  activeSideProvider,
  supportedProviders,
  effectiveProvider,
  onSelectProvider,
}: SideChatHeaderProps) {
  const { t } = useTranslation();

  let providerSection: ReactNode = null;
  if (isStarted && activeSideProvider) {
    providerSection = (
      <View style={styles.providerBadgeFixed} testID={SIDE_CHAT_TEST_IDS.providerBadge}>
        <Text style={styles.providerBadgeText}>{activeSideProvider}</Text>
      </View>
    );
  } else if (supportedProviders.length > 0) {
    providerSection = (
      <DropdownMenu>
        <DropdownMenuTrigger
          style={styles.providerBadge}
          testID={SIDE_CHAT_TEST_IDS.providerTrigger}
          accessibilityRole="button"
        >
          <Text style={styles.providerBadgeText}>
            {effectiveProvider ?? t("panels.side.chooseProvider", { defaultValue: "Provider" })}
          </Text>
          <ChevronDown size={12} color={styles.providerChevron.color} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {supportedProviders.map((p) => (
            <ProviderMenuItem key={p} provider={p} onSelect={onSelectProvider} />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <View style={styles.header} testID={SIDE_CHAT_TEST_IDS.header}>
      <ThemedBotMessageSquare size={16} uniProps={accentColorMapping} />
      <Text style={styles.headerTitle} numberOfLines={1}>
        {t("panels.side.linkedTo", {
          title: mainAgentTitle || mainAgentId,
          defaultValue: `Linked to: ${mainAgentTitle || mainAgentId}`,
        })}
      </Text>
      {providerSection}
    </View>
  );
}

interface SideChatTranscriptProps {
  chatData?: SideChatSnapshot;
  isLoading: boolean;
  isError: boolean;
  errorMessage?: string;
  onRetry: () => void;
  mainAgentId: string;
  client: DaemonClient | null;
  isRunning: boolean;
  isStopping: boolean;
  onStop: () => void;
}

function SideChatTranscript({
  chatData,
  isLoading,
  isError,
  errorMessage,
  onRetry,
  mainAgentId,
  client,
  isRunning,
  isStopping,
  onStop,
}: SideChatTranscriptProps) {
  const { t } = useTranslation();
  const scrollViewRef = useRef<ScrollView | null>(null);

  const handleContentSizeChange = useCallback(() => {
    scrollViewRef.current?.scrollToEnd({ animated: true });
  }, []);

  if (isLoading && !chatData) {
    return (
      <View style={styles.centerState} testID={SIDE_CHAT_TEST_IDS.loading}>
        <LoadingSpinner color={styles.spinner.color} size="small" />
        <Text style={styles.stateDescription}>
          {t("workspace.tabs.loading", { defaultValue: "Loading..." })}
        </Text>
      </View>
    );
  }

  if (isError && !chatData) {
    return (
      <View style={styles.centerState} testID={SIDE_CHAT_TEST_IDS.error}>
        <ThemedCircleAlert size={24} uniProps={errorColorMapping} />
        <Text style={styles.errorText}>
          {errorMessage || t("panels.side.loadError", { defaultValue: "Failed to load side chat" })}
        </Text>
        <Button size="sm" variant="outline" onPress={onRetry}>
          {t("panels.side.retry", { defaultValue: "Retry" })}
        </Button>
      </View>
    );
  }

  const messages = chatData?.messages ?? [];
  const steeringProposal = chatData?.steeringProposal;

  return (
    <ScrollView
      ref={scrollViewRef}
      style={styles.messagesScroll}
      contentContainerStyle={styles.messagesContent}
      onContentSizeChange={handleContentSizeChange}
    >
      {messages.map((msg) => (
        <View
          key={msg.id}
          style={msg.role === "user" ? styles.userMessageCard : styles.assistantMessageCard}
          testID={`side-message-${msg.role}-${msg.id}`}
        >
          <Text style={styles.roleLabel}>
            {msg.role === "user"
              ? t("panels.side.userLabel", { defaultValue: "You" })
              : t("panels.side.assistantLabel", { defaultValue: "Side" })}
          </Text>
          {msg.role === "user" ? (
            <Text style={styles.userMessageText}>{msg.text}</Text>
          ) : (
            <MarkdownRenderer text={msg.text} compact />
          )}
        </View>
      ))}

      {steeringProposal ? (
        <SteeringProposalCard
          key={`${chatData?.mainAgentId ?? mainAgentId}:${steeringProposal}`}
          proposal={steeringProposal}
          mainAgentId={chatData?.mainAgentId ?? mainAgentId}
          client={client}
        />
      ) : null}

      {isRunning ? (
        <View style={styles.runningBanner} testID={SIDE_CHAT_TEST_IDS.runningIndicator}>
          <LoadingSpinner color={styles.spinner.color} size="small" />
          <Text style={styles.runningText}>
            {t("panels.side.running", { defaultValue: "Side agent is working..." })}
          </Text>
          <Button
            size="xs"
            variant="outline"
            loading={isStopping}
            onPress={onStop}
            testID={SIDE_CHAT_TEST_IDS.stopButton}
          >
            {t("panels.side.stop", { defaultValue: "Stop" })}
          </Button>
        </View>
      ) : null}
    </ScrollView>
  );
}

interface SideChatComposerBarProps {
  draft: string;
  isSending: boolean;
  isRunning: boolean;
  canSend: boolean;
  combinedError: string | null;
  resetKey: number;
  onDraftChange: (text: string) => void;
  onSend: () => void;
  onSendStatusUpdate: () => void;
}

type SideInputKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & { shiftKey?: boolean; isComposing?: boolean; keyCode?: number }
>;
function SideChatComposerBar({
  draft,
  isSending,
  isRunning,
  canSend,
  combinedError,
  resetKey,
  onDraftChange,
  onSend,
  onSendStatusUpdate,
}: SideChatComposerBarProps) {
  const { t } = useTranslation();
  const sendDisabled = !draft.trim() || isSending || isRunning || !canSend;
  const statusDisabled = isSending || isRunning || !canSend;
  const handleKeyPress = useCallback(
    (event: SideInputKeyPressEvent) => {
      if (
        event.nativeEvent.key !== "Enter" ||
        event.nativeEvent.shiftKey ||
        isImeComposingKeyboardEvent(event.nativeEvent)
      )
        return;
      event.preventDefault();
      if (!sendDisabled) onSend();
    },
    [sendDisabled, onSend],
  );

  return (
    <View>
      {combinedError ? (
        <View style={styles.errorBanner} testID={SIDE_CHAT_TEST_IDS.errorBanner}>
          <ThemedCircleAlert size={14} uniProps={errorColorMapping} />
          <Text style={styles.errorBannerText}>{combinedError}</Text>
        </View>
      ) : null}

      <View style={styles.inputBar}>
        <AdaptiveTextInput
          style={styles.textInput}
          placeholder={t("panels.side.inputPlaceholder", {
            defaultValue: "Ask Side about this session...",
          })}
          initialValue=""
          resetKey={resetKey}
          onChangeText={onDraftChange}
          onKeyPress={handleKeyPress}
          editable={!isSending}
          multiline
          testID={SIDE_CHAT_TEST_IDS.input}
        />
        <View style={styles.composerActions}>
          <Button
            size="sm"
            disabled={sendDisabled}
            loading={isSending}
            onPress={onSend}
            testID={SIDE_CHAT_TEST_IDS.sendButton}
          >
            {t("panels.side.send", { defaultValue: "Send" })}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={statusDisabled}
            onPress={onSendStatusUpdate}
            testID={SIDE_CHAT_TEST_IDS.statusButton}
          >
            {t("panels.side.statusUpdate", { defaultValue: "Status update" })}
          </Button>
        </View>
      </View>
    </View>
  );
}

interface SideChatViewProps {
  serverId: string;
  mainAgentId: string;
  mainAgentTitle: string | null;
  mainAgentProvider: string | null;
  client: DaemonClient | null;
  isActive: boolean;
}

export function SideChatView({
  serverId,
  mainAgentId,
  mainAgentTitle,
  mainAgentProvider,
  client,
  isActive,
}: SideChatViewProps) {
  const { t } = useTranslation();
  const queryKey = useMemo(() => ["sideChat", serverId, mainAgentId], [serverId, mainAgentId]);

  const queryFn = useCallback(async () => {
    if (!client) throw new Error("Client unavailable");
    return client.getSideChat(mainAgentId);
  }, [client, mainAgentId]);

  const refetchInterval = useCallback(
    (query: { state: { data?: unknown } }) => {
      const data = query.state.data as SideChatSnapshot | undefined;
      return isActive && data?.status === "running" ? 1000 : false;
    },
    [isActive],
  );

  const chatQuery = useFetchQuery<SideChatSnapshot, Error>({
    queryKey,
    queryFn,
    dataShape: "value",
    staleTimeMs: 1000,
    enabled: Boolean(client && isActive),
    refetchInterval,
  });

  const supportedProviders = useMemo(
    () => chatQuery.data?.supportedProviders ?? [],
    [chatQuery.data?.supportedProviders],
  );

  const isStarted = Boolean(chatQuery.data?.sideAgentId);
  const activeSideProvider = chatQuery.data?.provider ?? null;

  const composer = useSideComposer({
    client,
    mainAgentId,
    queryKey,
    activeSideProvider,
    mainAgentProvider,
    supportedProviders,
  });

  const handleRetry = useCallback(() => {
    void chatQuery.refetch();
  }, [chatQuery]);

  const combinedError =
    composer.sendError ??
    chatQuery.data?.error ??
    (chatQuery.isError ? chatQuery.error?.message : null);

  return (
    <View style={styles.chatContainer} testID={SIDE_CHAT_TEST_IDS.view}>
      <SideChatHeader
        mainAgentTitle={mainAgentTitle}
        mainAgentId={mainAgentId}
        isStarted={isStarted}
        activeSideProvider={activeSideProvider ?? composer.selectedProvider}
        supportedProviders={supportedProviders}
        effectiveProvider={composer.effectiveProvider}
        onSelectProvider={composer.handleSelectProvider}
      />

      {!isStarted && !composer.isMainProviderSupported && (
        <View style={styles.unsupportedBanner} testID={SIDE_CHAT_TEST_IDS.unsupportedBanner}>
          <Text style={styles.unsupportedBannerText}>
            {t("panels.side.unsupportedMainProvider", {
              defaultValue: "Main agent provider is not supported for Side. Choose a provider:",
            })}
          </Text>
        </View>
      )}

      <SideChatTranscript
        chatData={chatQuery.data}
        isLoading={chatQuery.isLoading}
        isError={chatQuery.isError}
        errorMessage={chatQuery.error?.message}
        onRetry={handleRetry}
        mainAgentId={mainAgentId}
        client={client}
        isRunning={chatQuery.data?.status === "running"}
        isStopping={composer.isStopping}
        onStop={composer.handleStop}
      />

      <SideChatComposerBar
        draft={composer.draft}
        isSending={composer.isSending}
        isRunning={chatQuery.data?.status === "running"}
        canSend={Boolean(composer.effectiveProvider)}
        combinedError={combinedError}
        resetKey={composer.resetKey}
        onDraftChange={composer.handleDraftChange}
        onSend={composer.handleSend}
        onSendStatusUpdate={composer.handleStatusUpdate}
      />
    </View>
  );
}

export function SidePanel() {
  const { serverId, workspaceId } = usePaneContext();
  const { t } = useTranslation();
  const isActive = useRetainedPanelActive();
  const client = useHostRuntimeClient(serverId);

  const { mainAgentId, mainAgentTitle, mainAgentProvider } = useSelectedMainAgentFromLayout({
    serverId,
    workspaceId,
  });

  const hasCapability = client?.getLastServerInfoMessage()?.features?.sideChat === true;

  if (client && !hasCapability) {
    return (
      <View style={styles.stateContainer} testID={SIDE_CHAT_TEST_IDS.capabilityMissing}>
        <ThemedCircleAlert size={28} uniProps={mutedColorMapping} />
        <Text style={styles.stateTitle}>
          {t("panels.side.capabilityMissing", {
            defaultValue: "Update the host to use Side chat.",
          })}
        </Text>
      </View>
    );
  }

  if (!mainAgentId) {
    return (
      <View style={styles.stateContainer} testID={SIDE_CHAT_TEST_IDS.emptyState}>
        <ThemedBotMessageSquare size={32} uniProps={mutedColorMapping} />
        <Text style={styles.stateTitle}>
          {t("panels.side.emptyTitle", { defaultValue: "No main agent selected" })}
        </Text>
        <Text style={styles.stateDescription}>
          {t("panels.side.emptyDescription", {
            defaultValue: "Select or focus an agent tab in the main workspace to chat with Side.",
          })}
        </Text>
      </View>
    );
  }

  return (
    <SideChatView
      key={`${serverId}:${mainAgentId}`}
      serverId={serverId}
      mainAgentId={mainAgentId}
      mainAgentTitle={mainAgentTitle}
      mainAgentProvider={mainAgentProvider}
      client={client}
      isActive={isActive}
    />
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

const styles = StyleSheet.create((theme) => ({
  stateContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[2],
  },
  stateTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: "600",
    color: theme.colors.foreground,
    textAlign: "center",
  },
  stateDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
  chatContainer: {
    flex: 1,
    backgroundColor: theme.colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  headerTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500",
    color: theme.colors.foreground,
    flex: 1,
  },
  providerBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  providerBadgeFixed: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
  },
  providerBadgeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  providerChevron: {
    color: theme.colors.foregroundMuted,
  },
  unsupportedBanner: {
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  unsupportedBannerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  messagesScroll: {
    flex: 1,
  },
  messagesContent: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  roleLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[1],
  },
  userMessageCard: {
    alignSelf: "flex-end",
    maxWidth: "88%",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  userMessageText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  assistantMessageCard: {
    alignSelf: "flex-start",
    width: "100%",
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
  },
  steeringCard: {
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  steeringHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  steeringTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.primary,
  },
  steeringInput: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    minHeight: 56,
    textAlignVertical: "top",
  },
  steeringActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  steerSuccessRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  steerSuccessText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.success,
    fontWeight: "500",
  },
  steerErrorContainer: {
    paddingVertical: theme.spacing[1],
  },
  runningBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  runningText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flex: 1,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  errorBannerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    flex: 1,
  },
  composerActions: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[1],
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.destructive,
    textAlign: "center",
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  textInput: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.background,
    borderRadius: theme.borderRadius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    maxHeight: 120,
    minHeight: 36,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
