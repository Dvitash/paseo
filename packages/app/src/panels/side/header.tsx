import React, { useCallback, useState } from "react";
import { Text, View } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SideChatSnapshot } from "@getpaseo/protocol/side";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useStableEvent } from "@/hooks/use-stable-event";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { sideContextLabel, type SideDraft } from "./state";
import { styles } from "./styles";
import { SIDE_CHAT_TEST_IDS } from "../side-panel-state";

interface SideHeaderProps {
  snapshot: SideChatSnapshot | undefined;
  serverId: string;
  client: DaemonClient | null;
  mainAgentId: string;
  mainAgentTitle: string;
  provider: string | null;
  draft: SideDraft;
  updateDraft: (patch: Partial<SideDraft>) => void;
  isActive: boolean;
  pinned?: boolean;
  onTogglePin?: () => void;
  onOpenMain?: () => void;
}
function PickerOption({
  value,
  label,
  testID,
  onPick,
}: {
  value: string | null;
  label: string;
  testID?: string;
  onPick: (value: string | null) => void;
}) {
  const pick = useCallback(() => onPick(value), [onPick, value]);
  return (
    <DropdownMenuItem onSelect={pick} testID={testID}>
      {label}
    </DropdownMenuItem>
  );
}
function SideProviderControls({
  snapshot,
  serverId,
  client,
  mainAgentId,
  provider,
  draft,
  updateDraft,
  isActive,
}: SideHeaderProps) {
  const started = Boolean(snapshot?.sideAgentId);
  const fetchModels = useCallback(async () => {
    if (!client || !provider) throw new Error("Provider unavailable");
    const result = await client.listProviderModels(provider);
    if (result.error) throw new Error(result.error);
    return result.models ?? [];
  }, [client, provider]);
  const models = useFetchQuery({
    queryKey: ["side-models", serverId, provider, mainAgentId],
    queryFn: fetchModels,
    dataShape: "list",
    staleTimeMs: 30_000,
    enabled: Boolean(client && provider && isActive && !started),
  });
  const pickProvider = useCallback(
    (value: string | null) => updateDraft({ provider: value, model: null }),
    [updateDraft],
  );
  const pickModel = useCallback(
    (value: string | null) => updateDraft({ model: value }),
    [updateDraft],
  );
  const defaultModel = provider === snapshot?.provider ? snapshot?.model : null;
  const model = started ? snapshot?.model : (draft.model ?? defaultModel);
  if (started)
    return (
      <Text style={styles.muted} testID={SIDE_CHAT_TEST_IDS.providerBadge}>
        {provider} · {model ?? "Provider default"}
      </Text>
    );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={Boolean(draft.submission)}
          style={styles.selector}
          accessibilityLabel="Side provider"
          testID={SIDE_CHAT_TEST_IDS.providerTrigger}
        >
          <Text style={styles.muted}>{provider ?? "Choose provider"} ▾</Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          {snapshot?.supportedProviders?.map((value) => (
            <PickerOption
              key={value}
              value={value}
              label={value}
              onPick={pickProvider}
              testID={`side-provider-option-${value}`}
            />
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={Boolean(draft.submission)}
          style={styles.selector}
          accessibilityLabel="Side model"
          testID="side-model-trigger"
        >
          <Text style={styles.muted} numberOfLines={1}>
            {model ?? "Provider default"} ▾
          </Text>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <PickerOption value={null} label="Provider default" onPick={pickModel} />
          {models.data
            ?.filter((item) => item.isSelectable !== false)
            .map((item) => (
              <PickerOption key={item.id} value={item.id} label={item.label} onPick={pickModel} />
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {models.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {models.error.message}
        </Text>
      ) : null}
    </>
  );
}
export function SideHeader(props: SideHeaderProps) {
  const {
    snapshot,
    client,
    mainAgentId,
    mainAgentTitle,
    draft,
    updateDraft,
    pinned,
    onTogglePin,
    onOpenMain,
  } = props;
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newConversation = useStableEvent(async () => {
    if (!client || !snapshot?.conversationId || resetting) return;
    const confirmed = await confirmDialog({
      title: "New Side conversation?",
      message:
        "Archive this Side conversation and start fresh. The main session will not be changed.",
      confirmLabel: "Start fresh",
    });
    if (!confirmed) return;
    setResetting(true);
    setError(null);
    try {
      await client.resetSideChat(mainAgentId, snapshot.conversationId);
      updateDraft({ submission: null });
      await client.refreshSideChat(mainAgentId);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setResetting(false);
    }
  });
  const hasPendingDelivery = snapshot?.messages.some(
    (message) => message.proposal?.delivery?.status === "pending",
  );
  const resetDisabled =
    !snapshot?.sideAgentId ||
    resetting ||
    snapshot.status === "running" ||
    hasPendingDelivery ||
    Boolean(draft.submission);
  return (
    <View style={styles.header} testID={SIDE_CHAT_TEST_IDS.header}>
      <View style={styles.spread}>
        <Text style={[styles.title, styles.grow]} numberOfLines={1}>
          Side · {mainAgentTitle}
        </Text>
        {onTogglePin ? (
          <Button
            size="sm"
            variant="ghost"
            onPress={onTogglePin}
            accessibilityLabel={pinned ? "Follow active session" : "Pin Side to this session"}
          >
            {pinned ? "Pinned" : "Following"}
          </Button>
        ) : null}
      </View>
      <Text style={styles.muted} testID="side-context-status">
        {sideContextLabel(snapshot)}
      </Text>
      <View style={styles.row}>
        <SideProviderControls {...props} />
        {onOpenMain ? (
          <Button size="sm" variant="ghost" onPress={onOpenMain}>
            Open main
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={resetDisabled}
          loading={resetting}
          onPress={newConversation}
          testID="side-new-conversation"
        >
          New chat
        </Button>
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
