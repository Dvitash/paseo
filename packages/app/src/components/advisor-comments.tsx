import React, { memo, useMemo } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  parseAdvisorComments,
  getAdvisorSeverityLabel,
  type ParsedAdvisorComment,
} from "@/tool-calls/advisor";

export interface AdvisorCommentsProps {
  text?: string;
  label?: string;
  disableOuterSpacing?: boolean;
  testID?: string;
}

export const AdvisorComments = memo(function AdvisorComments({
  text,
  label,
  disableOuterSpacing = false,
  testID = "timeline-advisor-comments",
}: AdvisorCommentsProps) {
  const comments = useMemo<ParsedAdvisorComment[]>(() => {
    const parsed = parseAdvisorComments(text);
    if (parsed.length > 0) {
      return parsed;
    }
    if (label && label.trim()) {
      return [
        {
          id: "advisor-comment-0",
          severity: "neutral",
          text: label.trim(),
        },
      ];
    }
    return [];
  }, [text, label]);

  if (comments.length === 0) {
    return null;
  }

  return (
    <View
      testID={testID}
      style={[styles.container, disableOuterSpacing && styles.containerCompact]}
    >
      <Text style={styles.heading} accessibilityRole="header">
        Advisor
      </Text>
      <View style={styles.commentsList}>
        {comments.map((comment) => (
          <AdvisorCommentItem key={comment.id} comment={comment} />
        ))}
      </View>
    </View>
  );
});

function AdvisorCommentItem({ comment }: { comment: ParsedAdvisorComment }) {
  const severityLabel = getAdvisorSeverityLabel(comment.severity);

  return (
    <View
      testID={`advisor-comment-item-${comment.severity}`}
      style={[
        styles.commentItem,
        comment.severity === "nit" && styles.nitAccent,
        comment.severity === "concern" && styles.concernAccent,
        comment.severity === "blocker" && styles.blockerAccent,
      ]}
    >
      <Text
        style={[
          styles.commentLabel,
          comment.severity === "nit" && styles.nitLabel,
          comment.severity === "concern" && styles.concernLabel,
          comment.severity === "blocker" && styles.blockerLabel,
        ]}
      >
        {severityLabel}
        {comment.advisor ? ` · ${comment.advisor}` : null}
      </Text>
      <Text style={styles.commentText} selectable>
        {comment.text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    marginVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  containerCompact: {
    marginVertical: 0,
  },
  heading: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  commentsList: {
    gap: theme.spacing[3],
  },
  commentItem: {
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 3,
    borderLeftColor: theme.colors.border,
    gap: theme.spacing[1],
  },
  nitAccent: {
    borderLeftColor: theme.colors.palette.blue[500],
  },
  concernAccent: {
    borderLeftColor: theme.colors.statusWarning,
  },
  blockerAccent: {
    borderLeftColor: theme.colors.statusDanger,
  },
  commentLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  nitLabel: {
    color:
      theme.colorScheme === "dark"
        ? theme.colors.palette.blue[400]
        : theme.colors.palette.blue[600],
  },
  concernLabel: {
    color: theme.colors.statusWarning,
  },
  blockerLabel: {
    color: theme.colors.statusDanger,
  },
  commentText: {
    fontSize: theme.fontSize.content,
    lineHeight: theme.fontSize.content * 1.5,
    color: theme.colors.foreground,
  },
}));
