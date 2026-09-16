import React, { useCallback, useRef } from "react";
import {
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import type { SideChatAction, SideChatReference } from "@getpaseo/protocol/side";
import { AdaptiveTextInput } from "@/components/adaptive-text-input";
import { KeyboardDock } from "@/components/keyboard-dock";
import { Button } from "@/components/ui/button";
import { useStableEvent } from "@/hooks/use-stable-event";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";
import type { SideDraft } from "./state";
import { styles } from "./styles";
import { SIDE_CHAT_TEST_IDS } from "../side-panel-state";

type KeyEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & { shiftKey?: boolean; isComposing?: boolean; keyCode?: number }
>;
interface SideComposerProps {
  draft: SideDraft;
  running: boolean;
  canSend: boolean;
  updateDraft: (patch: Partial<SideDraft>) => void;
  send: (action?: SideChatAction) => void;
  onOpenReference: (reference: SideChatReference) => void;
}
function AttachedReference({
  reference,
  onOpen,
  onRemove,
}: {
  reference: SideChatReference;
  onOpen: SideComposerProps["onOpenReference"];
  onRemove: (id: string) => void;
}) {
  const open = useCallback(() => onOpen(reference), [onOpen, reference]);
  const remove = useCallback(() => onRemove(reference.id), [onRemove, reference.id]);
  return (
    <View style={styles.spread}>
      <Button size="sm" variant="ghost" onPress={open}>
        {reference.label}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        accessibilityLabel={`Remove reference ${reference.label}`}
        onPress={remove}
      >
        Remove
      </Button>
    </View>
  );
}
export function SideComposer({
  draft,
  running,
  canSend,
  updateDraft,
  send,
  onOpenReference,
}: SideComposerProps) {
  const previousText = useRef(draft.text);
  const reset = useRef(0);
  // EditingTextInput owns keystrokes. Only external draft changes replace its text.
  if (previousText.current !== draft.text) {
    previousText.current = draft.text;
    reset.current++;
  }
  const change = useCallback(
    (text: string) => {
      previousText.current = text;
      updateDraft({ text });
    },
    [updateDraft],
  );
  const disabled = !canSend || running || Boolean(draft.submission);
  const sendQuestion = useCallback(() => send("question"), [send]);
  const sendStatus = useCallback(() => send("status"), [send]);
  const sendReview = useCallback(() => send("review"), [send]);
  const sendSteer = useCallback(() => send("steer"), [send]);
  const removeReference = useStableEvent((id: string) =>
    updateDraft({ references: draft.references.filter((reference) => reference.id !== id) }),
  );
  const keyPress = useCallback(
    (event: KeyEvent) => {
      if (
        event.nativeEvent.key !== "Enter" ||
        event.nativeEvent.shiftKey ||
        isImeComposingKeyboardEvent(event.nativeEvent)
      )
        return;
      event.preventDefault();
      if (!disabled && draft.text.trim()) sendQuestion();
    },
    [disabled, draft.text, sendQuestion],
  );
  return (
    <KeyboardDock>
      <View style={styles.composer}>
        <View style={styles.row}>
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onPress={sendStatus}
            testID={SIDE_CHAT_TEST_IDS.statusButton}
          >
            Status
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onPress={sendReview}>
            Review changes
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onPress={sendSteer}>
            Draft steer
          </Button>
        </View>
        {draft.references.map((reference) => (
          <AttachedReference
            key={reference.id}
            reference={reference}
            onOpen={onOpenReference}
            onRemove={removeReference}
          />
        ))}
        <AdaptiveTextInput
          initialValue={draft.text}
          resetKey={reset.current}
          onChangeText={change}
          onKeyPress={keyPress}
          maxLength={32_000}
          multiline
          style={styles.input}
          placeholder="Ask Side about this session…"
          accessibilityLabel="Message Side"
          testID={SIDE_CHAT_TEST_IDS.input}
        />
        <View style={styles.spread}>
          <Text style={[styles.muted, styles.grow]}>Read-only · main continues independently</Text>
          <Button
            size="sm"
            disabled={disabled || !draft.text.trim()}
            onPress={sendQuestion}
            testID={SIDE_CHAT_TEST_IDS.sendButton}
          >
            Send
          </Button>
        </View>
      </View>
    </KeyboardDock>
  );
}
