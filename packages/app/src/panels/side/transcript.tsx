import { useStableEvent } from "@/hooks/use-stable-event";
import React, { useCallback, useRef, useState } from "react";
import {
  Text,
  View,
  ScrollView,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SideChatMessage, SideChatReference, SideChatSnapshot } from "@getpaseo/protocol/side";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { TurnCopyButton } from "@/components/turn-copy-button";
import { Button } from "@/components/ui/button";
import { SteeringProposalCard } from "./proposal";
import { isNearSideBottom, type SideSubmission } from "./state";
import { styles } from "./styles";

interface ScrollPosition {
  offset: number;
  following: boolean;
}
const positions = new Map<string, ScrollPosition>();
interface SideMessageProps {
  message: SideChatMessage;
  sessionKey: string;
  mainAgentTitle: string;
  client: DaemonClient | null;
  onOpenReference: (reference: SideChatReference) => void;
  running: boolean;
  onOpenMainAt?: (seq: number, epoch: string) => void;
}
function ReferencePreview({
  reference,
  onOpen,
}: {
  reference: SideChatReference;
  onOpen: SideMessageProps["onOpenReference"];
}) {
  const open = useCallback(() => onOpen(reference), [onOpen, reference]);
  return (
    <View style={styles.reference}>
      <Button size="sm" variant="ghost" onPress={open}>
        {reference.label}
      </Button>
      <Text selectable numberOfLines={3} style={styles.muted}>
        {reference.text}
      </Text>
    </View>
  );
}

export function SideMessage({
  message,
  sessionKey,
  mainAgentTitle,
  client,
  onOpenReference,
  running,
  onOpenMainAt,
}: SideMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const getContent = useCallback(() => message.text, [message.text]);
  const long = message.text.length > 2400 && !running;
  const excerpt = long && !expanded ? `${message.text.slice(0, 2400)}\n\n…` : message.text;
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);
  const onLinkPress = useStableEvent((url: string) => {
    const match = /^side-main:(\d+)$/.exec(url);
    if (!match) return true;
    if (message.context) onOpenMainAt?.(Number(match[1]), message.context.epoch);
    return false;
  });
  if (!message.text.trim() && !message.proposal) return null;
  const user = message.role === "user";
  let content: React.ReactNode = null;
  if (message.text.trim())
    content = user ? (
      <Text selectable style={styles.text}>
        {message.text}
      </Text>
    ) : (
      <MarkdownRenderer text={excerpt} compact onLinkPress={onLinkPress} />
    );
  return (
    <View
      style={user ? styles.user : styles.assistant}
      testID={`side-message-${message.role}-${message.id}`}
    >
      {content}
      {long ? (
        <Button size="sm" variant="ghost" onPress={toggleExpanded}>
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
      {message.references?.map((reference) => (
        <ReferencePreview key={reference.id} reference={reference} onOpen={onOpenReference} />
      ))}
      {!user && message.text.trim() ? (
        <View style={styles.row}>
          <TurnCopyButton getContent={getContent} />
          {message.context ? (
            <Text style={styles.muted}>
              Main through #{message.context.seq}
              {message.context.truncated ? " · abridged" : ""}
            </Text>
          ) : null}
          {message.createdAt ? (
            <Text style={styles.muted}>
              {new Date(message.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Text>
          ) : null}
        </View>
      ) : null}
      {message.proposal ? (
        <SteeringProposalCard
          proposal={message.proposal}
          sessionKey={sessionKey}
          mainAgentTitle={mainAgentTitle}
          client={client}
        />
      ) : null}
    </View>
  );
}
interface SideTranscriptProps {
  snapshot: SideChatSnapshot;
  sessionKey: string;
  mainAgentTitle: string;
  client: DaemonClient | null;
  submission: SideSubmission | null;
  onRetry: () => void;
  onDiscard: () => void;
  onOpenMainAt?: (seq: number, epoch: string) => void;
  onOpenReference: (reference: SideChatReference) => void;
}
export function SideTranscript({
  snapshot,
  sessionKey,
  mainAgentTitle,
  client,
  submission,
  onRetry,
  onDiscard,
  onOpenReference,
  onOpenMainAt,
}: SideTranscriptProps) {
  const scroll = useRef<ScrollView | null>(null);
  const key = `${sessionKey}:${snapshot.conversationId}`;
  const position = useRef<ScrollPosition>(positions.get(key) ?? { offset: 0, following: true });
  const restored = useRef(false);
  const [unread, setUnread] = useState(false);
  const [showStatus, setShowStatus] = useState(true);
  const toggleStatus = useCallback(() => setShowStatus((value) => !value), []);
  const latestStatus = snapshot.messages.findLast(
    (message) => message.role === "assistant" && message.action === "status",
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      if (layoutMeasurement.height <= 0) return;
      position.current = {
        offset: contentOffset.y,
        following: isNearSideBottom(contentOffset.y, layoutMeasurement.height, contentSize.height),
      };
      positions.set(key, position.current);
      if (position.current.following) setUnread(false);
    },
    [key],
  );
  const onContentSizeChange = useCallback(() => {
    if (!restored.current) {
      restored.current = true;
      if (!position.current.following) {
        scroll.current?.scrollTo({ y: position.current.offset, animated: false });
        return;
      }
    }
    if (position.current.following) scroll.current?.scrollToEnd({ animated: false });
    else setUnread(true);
  }, []);
  const jump = useCallback(() => {
    position.current.following = true;
    setUnread(false);
    scroll.current?.scrollToEnd({ animated: true });
  }, []);
  return (
    <View style={styles.container}>
      <ScrollView
        ref={scroll}
        style={styles.container}
        contentContainerStyle={styles.messages}
        onScroll={onScroll}
        scrollEventThrottle={100}
        onContentSizeChange={onContentSizeChange}
        keyboardShouldPersistTaps="handled"
      >
        {snapshot.messages.length === 0 ? (
          <Text style={styles.muted}>
            Ask about a decision, verify a change, or draft an instruction. Side is read-only; main
            keeps working.
          </Text>
        ) : null}
        {snapshot.messages
          .filter((message) => message.action !== "status")
          .map((message) => (
            <SideMessage
              key={message.id}
              message={message}
              sessionKey={sessionKey}
              mainAgentTitle={mainAgentTitle}
              client={client}
              onOpenReference={onOpenReference}
              onOpenMainAt={onOpenMainAt}
              running={snapshot.status === "running" && message.id === snapshot.messages.at(-1)?.id}
            />
          ))}
        {latestStatus ? (
          <View style={styles.status} testID="side-latest-status">
            <View style={styles.spread}>
              <Text style={styles.title}>Latest status</Text>
              <Button size="sm" variant="ghost" onPress={toggleStatus}>
                {showStatus ? "Collapse" : "Expand"}
              </Button>
            </View>
            {showStatus ? (
              <SideMessage
                message={latestStatus}
                sessionKey={sessionKey}
                mainAgentTitle={mainAgentTitle}
                client={client}
                onOpenReference={onOpenReference}
                onOpenMainAt={onOpenMainAt}
                running={snapshot.status === "running"}
              />
            ) : null}
          </View>
        ) : null}
        {submission && !snapshot.messages.some((message) => message.id === submission.id) ? (
          <View style={styles.user} testID="side-pending-message">
            <Text selectable style={styles.text}>
              {submission.text}
            </Text>
            <Text style={submission.error ? styles.error : styles.muted}>
              {submission.error ?? "Sending…"}
            </Text>
            <View style={styles.row}>
              <Button size="sm" variant="ghost" onPress={onRetry}>
                Retry same request
              </Button>
              <Button size="sm" variant="ghost" onPress={onDiscard}>
                Dismiss
              </Button>
            </View>
          </View>
        ) : null}
      </ScrollView>
      {unread ? (
        <Button size="sm" variant="secondary" onPress={jump} testID="side-new-response">
          New response ↓
        </Button>
      ) : null}
    </View>
  );
}
