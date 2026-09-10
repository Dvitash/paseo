import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { ScrollView } from "@/components/ui/scroll-view";
import { Button } from "@/components/ui/button";
import { HighlightedLines } from "@/components/highlighted-content";
import { DiffViewer } from "@/components/diff-viewer";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { extensionFromPath, highlightToKeyedLines } from "@/utils/highlight-cache";
import { highlightDiffLines } from "@/utils/diff-highlight";
import { buildLineDiff, parseUnifiedDiff } from "@/utils/tool-call-parsers";
import type { EvalPresentation } from "./eval";
import { boundToolText } from "./preview";
import type { HubPresentation } from "./hub";
import { HubContent } from "./hub-content";

interface CodeContentProps {
  text: string;
  language: string | null;
  numbered?: boolean;
  wrap?: boolean;
  maxHeight?: number;
}

const CodeContent = memo(function CodeContent({
  text,
  language,
  numbered = false,
  wrap = false,
  maxHeight,
}: CodeContentProps) {
  const lines = useMemo(() => highlightToKeyedLines(text, language), [text, language]);
  const heightStyle = maxHeight === undefined ? null : inlineUnistylesStyle({ maxHeight });
  const content =
    lines && !wrap ? (
      <HighlightedLines lines={lines} startLine={numbered ? 1 : undefined} />
    ) : (
      <Text selectable style={styles.code} dataSet={CODE_SURFACE_DATASET}>
        {text}
      </Text>
    );
  return (
    <ScrollView style={heightStyle} nestedScrollEnabled>
      {wrap ? (
        <View style={styles.codeInset}>{content}</View>
      ) : (
        <ScrollView horizontal nestedScrollEnabled>
          <View style={styles.codeInset}>{content}</View>
        </ScrollView>
      )}
    </ScrollView>
  );
});

interface EvalContentProps {
  evaluation: EvalPresentation;
  preview?: boolean;
  maxHeight?: number;
  errorText?: string;
}

export function EvalContent({
  evaluation,
  preview = false,
  maxHeight,
  errorText,
}: EvalContentProps) {
  const { t } = useTranslation();
  const cells = preview ? evaluation.cells.slice(0, 1) : evaluation.cells;
  return (
    <View style={styles.container} testID="tool-eval-content">
      {cells.map((cell) => {
        const code = preview ? boundToolText(cell.code, 8, 2400).text : cell.code;
        const output = preview ? boundToolText(cell.output, 4, 1200).text : cell.output;
        const cellTitle = evaluation.cells.length > 1 ? cell.title : null;
        const showOutput = output.length > 0 && output !== errorText;
        return (
          <View key={cell.id}>
            <View style={styles.sectionHeader}>
              <Text style={styles.label} numberOfLines={1}>
                {cellTitle ?? t("toolCallDetails.input")}
              </Text>
              {cell.language ? <Text style={styles.language}>{cell.language}</Text> : null}
            </View>
            <CodeContent text={code} language={cell.language} numbered maxHeight={maxHeight} />
            {showOutput ? (
              <View style={styles.output}>
                <View style={styles.sectionHeader}>
                  <Text style={styles.label}>{t("toolCallDetails.output")}</Text>
                </View>
                <CodeContent text={output} language={null} maxHeight={maxHeight} />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

interface ToolCallPreviewProps {
  detail: ToolCallDetail | undefined;
  evaluation: EvalPresentation | null;
  hub: HubPresentation | null;
  errorText?: string;
  onShowMore: () => void;
}

function isProseExtension(extension: string | null): boolean {
  return extension === null || extension === "txt" || extension === "md";
}

function buildEditPreview(detail: Extract<ToolCallDetail, { type: "edit" }>) {
  // Preview work is bounded before diffing: buildLineDiff uses a quadratic LCS.
  const before = boundToolText(detail.oldString ?? "", 80, 2400);
  const after = boundToolText(detail.newString ?? "", 80, 2400);
  const unified = boundToolText(detail.unifiedDiff ?? "", 160, 16000);
  const allLines = detail.unifiedDiff
    ? parseUnifiedDiff(unified.text)
    : buildLineDiff(before.text, after.text);
  const firstChange = allLines.findIndex((line) => line.type === "add" || line.type === "remove");
  const start = Math.max(0, firstChange - 2);
  const lines = allLines.slice(start, start + 6);
  const sourceTruncated = detail.unifiedDiff
    ? unified.truncated
    : before.truncated || after.truncated;
  const wrap = isProseExtension(extensionFromPath(detail.filePath));
  return {
    lines: highlightDiffLines(lines, detail.filePath),
    wrap,
    truncated:
      sourceTruncated ||
      start > 0 ||
      allLines.length > lines.length ||
      (wrap && lines.some((line) => line.content.length > 120)),
  };
}

export const ToolCallPreview = memo(function ToolCallPreview({
  detail,
  evaluation,
  hub,
  errorText,
  onShowMore,
}: ToolCallPreviewProps) {
  const { t } = useTranslation();
  const edit = useMemo(() => (detail?.type === "edit" ? buildEditPreview(detail) : null), [detail]);
  const error = boundToolText(errorText ?? "", 3, 1000);
  let truncated = error.truncated;
  let body;
  if (evaluation) {
    const cell = evaluation.cells[0];
    truncated ||= evaluation.cells.length > 1;
    truncated ||= boundToolText(cell.code, 8, 2400).truncated;
    truncated ||= boundToolText(cell.output, 4, 1200).truncated;
    body = <EvalContent evaluation={evaluation} preview maxHeight={180} errorText={error.text} />;
  } else if (hub) {
    body = <HubContent hub={hub} preview maxHeight={180} onShowMore={onShowMore} />;
  } else if (detail?.type === "write") {
    const content = boundToolText(detail.content ?? "", 8, 2400);
    const extension = extensionFromPath(detail.filePath);
    const wrap = isProseExtension(extension);
    truncated ||= content.truncated;
    // Wrapped prose can exceed the visible height even when it is a single source line.
    truncated ||= wrap && content.text.length > 240;
    body = (
      <CodeContent text={content.text} language={extension} numbered wrap={wrap} maxHeight={180} />
    );
  } else if (edit) {
    truncated ||= edit.truncated;
    body = <DiffViewer diffLines={edit.lines} maxHeight={180} wrap={edit.wrap} />;
  } else {
    return null;
  }
  return (
    <View style={styles.container} testID="tool-call-preview">
      {body}
      {error.text ? (
        <Text selectable style={styles.error}>
          {error.text}
        </Text>
      ) : null}
      {truncated ? (
        <View style={styles.footer}>
          <Button variant="ghost" size="xs" onPress={onShowMore}>
            {t("toolCallDetails.showMore")}
          </Button>
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    minWidth: 0,
    backgroundColor: theme.colors.surface1,
  },
  codeInset: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  code: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
  },
  label: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  language: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  output: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  footer: {
    alignItems: "flex-start",
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  error: {
    padding: theme.spacing[3],
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.statusDanger,
  },
}));
