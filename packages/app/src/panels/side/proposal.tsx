import { useStableEvent } from "@/hooks/use-stable-event";
import React, { useState } from "react";
import { Text, View } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SideSteeringProposal } from "@getpaseo/protocol/side";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { Button } from "@/components/ui/button";
import { toErrorMessage } from "@/utils/error-messages";
import { useSideWorkspaceStore } from "./state";
import { styles } from "./styles";
import { SIDE_CHAT_TEST_IDS } from "../side-panel-state";

interface SteeringProposalCardProps {
  proposal: SideSteeringProposal;
  sessionKey: string;
  mainAgentTitle: string;
  client: DaemonClient | null;
}
export function SteeringProposalCard({
  proposal,
  sessionKey,
  mainAgentTitle,
  client,
}: SteeringProposalCardProps) {
  const key = `${sessionKey}:${proposal.id}`;
  const draft = useSideWorkspaceStore((state) => state.proposalDrafts[key] ?? proposal.text);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const delivery = proposal.delivery;
  const delivered = delivery?.status === "delivered";
  const text = delivery?.text ?? draft;
  const changeText = useStableEvent((value: string) =>
    useSideWorkspaceStore.getState().editProposal(key, value),
  );
  const send = useStableEvent(async () => {
    if (!client || pending || delivered || !text.trim()) return;
    setPending(true);
    setError(null);
    try {
      await client.steerSideChat(proposal.mainAgentId, proposal.id, text);
      await client.refreshSideChat(proposal.mainAgentId);
    } catch (cause) {
      setError(toErrorMessage(cause));
    } finally {
      setPending(false);
    }
  });
  return (
    <View style={styles.proposal} testID={SIDE_CHAT_TEST_IDS.steeringCard}>
      <Text style={styles.title}>Proposed steering</Text>
      <Text style={styles.muted} numberOfLines={2}>
        To: {mainAgentTitle} · {proposal.mainAgentId}
      </Text>
      <AdaptiveTextInput
        initialValue={text}
        resetKey={delivery?.messageId ?? "draft"}
        onChangeText={changeText}
        multiline
        editable={!delivery && !pending}
        maxLength={32_000}
        style={styles.proposalInput}
        accessibilityLabel="Instruction to send to main"
        testID={SIDE_CHAT_TEST_IDS.steeringInput}
      />
      {error || delivery?.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error ?? delivery?.error}
        </Text>
      ) : null}
      {delivered ? (
        <Text style={styles.success}>
          Delivery confirmed ·{" "}
          {delivery.updatedAt
            ? new Date(delivery.updatedAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })
            : ""}{" "}
          · not yet verified as implemented
        </Text>
      ) : (
        <View style={styles.spread}>
          <Text style={[styles.muted, styles.grow]}>
            {delivery?.status === "pending"
              ? "Delivery unconfirmed. Retry uses the same request ID."
              : "Only this instruction is sent to main."}
          </Text>
          <Button
            size="sm"
            variant="secondary"
            disabled={!client || pending || !text.trim()}
            loading={pending}
            onPress={send}
            testID={SIDE_CHAT_TEST_IDS.steeringSendButton}
          >
            {delivery ? "Retry delivery" : "Send to main"}
          </Button>
        </View>
      )}
    </View>
  );
}
