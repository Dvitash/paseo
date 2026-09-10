import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ScrollView } from "@/components/ui/scroll-view";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import {
  capAssistantMessageForRender,
  getUtf8ByteLength,
} from "@/components/assistant-message-render-limit";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { HubPresentation } from "./hub";
import { boundToolText } from "./preview";

const EMPTY_IMAGE_HANDLERS = [] as const;
const TOTAL_PREVIEW_BUDGET = 1800;

export interface HubContentProps {
  hub: HubPresentation;
  preview?: boolean;
  maxHeight?: number;
  onShowMore?: () => void;
}

interface RenderedBlock {
  id: string;
  heading: string | null;
  meta: string | null;
  text: string;
  format: "prose" | "code";
  status?: string | null;
  duration?: string | null;
  isNoResultYet?: boolean;
  isCapped?: boolean;
  originalBytes?: number;
}

function getStatusVariant(
  status: string | null | undefined,
): "running" | "success" | "danger" | "muted" {
  if (!status) return "muted";
  const s = status.toLowerCase();
  if (s === "running" || s === "executing") return "running";
  if (
    s === "completed" ||
    s === "complete" ||
    s === "delivered" ||
    s === "injected" ||
    s === "ready"
  ) {
    return "success";
  }
  if (s === "failed" || s === "error") return "danger";
  return "muted";
}

function getLocalizedStatus(
  status: string | null | undefined,
  t: (key: string) => string,
): string | null {
  if (!status) return null;
  const s = status.toLowerCase();
  if (s === "running" || s === "executing") return t("hub.status.running");
  if (s === "completed" || s === "complete") return t("hub.status.completed");
  if (s === "delivered" || s === "injected") return t("hub.status.delivered");
  if (s === "ready") return t("hub.status.ready");
  if (s === "failed" || s === "error") return t("hub.status.failed");
  if (s === "idle") return t("hub.status.idle");
  if (s === "stopped") return t("hub.status.stopped");
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function renderBlockContent(
  block: RenderedBlock,
  preview: boolean,
  cappedNoticeText: string | null,
  t: (key: string) => string,
  maxLines: number,
) {
  if (block.isNoResultYet) {
    return (
      <View style={styles.proseContainer}>
        <Text style={styles.noResultYetText}>{t("hub.status.noResultYet")}</Text>
      </View>
    );
  }

  if (block.format === "prose") {
    if (preview) {
      return (
        <View style={styles.proseContainer}>
          <Text numberOfLines={maxLines} selectable style={styles.prosePreview}>
            {block.text}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.proseContainer}>
        <MarkdownRenderer
          text={block.text}
          compact
          enableHtmlish={false}
          allowedImageHandlers={EMPTY_IMAGE_HANDLERS}
        />
        {cappedNoticeText ? <Text style={styles.truncatedNotice}>{cappedNoticeText}</Text> : null}
      </View>
    );
  }

  if (preview) {
    return (
      <Text numberOfLines={maxLines} selectable style={styles.codePreview}>
        {block.text}
      </Text>
    );
  }

  return (
    <ScrollView horizontal nestedScrollEnabled style={styles.codeHorizontalScroll}>
      <Text selectable style={styles.code}>
        {block.text}
      </Text>
    </ScrollView>
  );
}

export const HubContent = memo(function HubContent({
  hub,
  preview = false,
  maxHeight,
  onShowMore,
}: HubContentProps) {
  const { t } = useTranslation();

  const { blocks, isTruncated, previewMaxLines } = useMemo(() => {
    if (!preview) {
      const fullBlocks: RenderedBlock[] = [];
      for (const block of hub.blocks) {
        if (block.format === "prose") {
          const capped = capAssistantMessageForRender(block.text);
          fullBlocks.push({
            id: block.id,
            heading: block.heading,
            meta: block.meta,
            text: capped.text,
            format: block.format,
            status: block.status,
            duration: block.duration,
            isCapped: capped.capped,
            originalBytes: capped.capped ? getUtf8ByteLength(block.text) : undefined,
          });
        } else {
          fullBlocks.push({
            id: block.id,
            heading: block.heading,
            meta: block.meta,
            text: block.text,
            format: block.format,
            status: block.status,
            duration: block.duration,
          });
        }
      }
      return { blocks: fullBlocks, isTruncated: false, previewMaxLines: 3 };
    }

    const candidateBlocks = hub.blocks.filter((b) => !b.omitFromPreview);
    const rawBlocks = candidateBlocks.slice(0, 3);
    let truncated = candidateBlocks.length > 3 || hub.blocks.some((b) => b.omitFromPreview);
    const maxLines = rawBlocks.length === 1 ? 3 : 2;
    let remainingBudget = TOTAL_PREVIEW_BUDGET;

    const boundedBlocks: RenderedBlock[] = [];
    for (const block of rawBlocks) {
      const isNoResult = block.isNoResultYet === true;
      const sourceText = isNoResult ? "" : (block.previewText ?? block.text);

      const perBlockLimit = Math.min(600, remainingBudget);
      const bounded = boundToolText(sourceText, maxLines, perBlockLimit);
      if (!isNoResult && (bounded.truncated || perBlockLimit < sourceText.length)) {
        truncated = true;
      }
      remainingBudget = Math.max(0, remainingBudget - bounded.text.length);

      const heading = block.previewHeading !== undefined ? block.previewHeading : block.heading;

      boundedBlocks.push({
        id: block.id,
        heading,
        meta: block.previewMeta ?? block.duration ?? null,
        text: bounded.text,
        format: block.format,
        status: block.status,
        duration: block.duration,
        isNoResultYet: isNoResult,
      });
    }

    return { blocks: boundedBlocks, isTruncated: truncated, previewMaxLines: maxLines };
  }, [hub.blocks, preview]);

  const heightStyle =
    !preview && maxHeight !== undefined ? inlineUnistylesStyle({ maxHeight }) : null;

  const content = (
    <View style={styles.blocksList}>
      {blocks.map((block, index) => {
        const statusText = getLocalizedStatus(block.status, t);
        const statusVariant = getStatusVariant(block.status);
        const metaText = block.meta;
        const hasHeader = Boolean(block.heading || metaText || statusText);
        const cappedNotice =
          block.isCapped && block.originalBytes !== undefined
            ? t("agentStream.messageCapped", { bytes: block.originalBytes })
            : null;

        return (
          <View key={block.id} style={[styles.block, index > 0 && styles.blockSeparator]}>
            {hasHeader ? (
              <View style={styles.header}>
                <View style={styles.headerLeft}>
                  {block.heading ? (
                    <Text style={styles.heading} numberOfLines={preview ? 1 : undefined}>
                      {block.heading}
                    </Text>
                  ) : null}
                  {statusText ? (
                    <View style={[styles.statusBadge, styles[`statusBadge_${statusVariant}`]]}>
                      <Text style={[styles.statusText, styles[`statusText_${statusVariant}`]]}>
                        {statusText}
                      </Text>
                    </View>
                  ) : null}
                </View>
                {metaText ? (
                  <Text style={styles.meta} numberOfLines={preview ? 1 : undefined}>
                    {metaText}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {renderBlockContent(block, preview, cappedNotice, t, previewMaxLines)}
          </View>
        );
      })}
    </View>
  );

  return (
    <View style={styles.container} testID="tool-hub-content">
      {heightStyle ? (
        <ScrollView style={heightStyle} nestedScrollEnabled>
          {content}
        </ScrollView>
      ) : (
        content
      )}
      {preview && isTruncated && onShowMore ? (
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
  blocksList: {
    minWidth: 0,
  },
  block: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  blockSeparator: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[1],
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flex: 1,
    minWidth: 0,
  },
  heading: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  statusBadge: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
  },
  statusBadge_running: {
    backgroundColor: theme.colors.surface2,
  },
  statusBadge_success: {
    backgroundColor: theme.colors.surface2,
  },
  statusBadge_danger: {
    backgroundColor: theme.colors.surface2,
  },
  statusBadge_muted: {
    backgroundColor: theme.colors.surface2,
  },
  statusText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    fontFamily: theme.fontFamily.ui,
  },
  statusText_running: {
    color: theme.colors.statusWarning,
  },
  statusText_success: {
    color: theme.colors.statusSuccess,
  },
  statusText_danger: {
    color: theme.colors.statusDanger,
  },
  statusText_muted: {
    color: theme.colors.foregroundMuted,
  },
  meta: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    maxWidth: "50%",
  },
  proseContainer: {
    minWidth: 0,
  },
  prosePreview: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  noResultYetText: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontStyle: "italic",
    color: theme.colors.foregroundMuted,
  },
  code: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
  codePreview: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    lineHeight: 18,
    color: theme.colors.foreground,
  },
  codeHorizontalScroll: {
    minWidth: 0,
  },
  footer: {
    alignItems: "flex-start",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  truncatedNotice: {
    marginTop: theme.spacing[1],
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
