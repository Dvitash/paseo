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
  isCapped?: boolean;
  originalBytes?: number;
}

function renderBlockContent(
  block: RenderedBlock,
  preview: boolean,
  cappedNoticeText: string | null,
) {
  if (block.format === "prose") {
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
      <Text selectable style={styles.code}>
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

  const { blocks, isTruncated } = useMemo(() => {
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
          });
        }
      }
      return { blocks: fullBlocks, isTruncated: false };
    }

    const rawBlocks = hub.blocks.slice(0, 3);
    let truncated = hub.blocks.length > 3;
    const maxLines = rawBlocks.length === 1 ? 6 : 3;
    let remainingBudget = TOTAL_PREVIEW_BUDGET;

    const boundedBlocks: RenderedBlock[] = [];
    for (const block of rawBlocks) {
      const perBlockLimit = Math.min(1600, remainingBudget);
      const bounded = boundToolText(block.text, maxLines, perBlockLimit);
      if (bounded.truncated || perBlockLimit < block.text.length) {
        truncated = true;
      }
      remainingBudget = Math.max(0, remainingBudget - bounded.text.length);
      boundedBlocks.push({
        id: block.id,
        heading: block.heading,
        meta: block.meta,
        text: bounded.text,
        format: block.format,
      });
    }

    return { blocks: boundedBlocks, isTruncated: truncated };
  }, [hub.blocks, preview]);

  const heightStyle = maxHeight !== undefined ? inlineUnistylesStyle({ maxHeight }) : null;

  const content = (
    <View style={styles.blocksList}>
      {blocks.map((block, index) => {
        const hasHeader = Boolean(block.heading || block.meta);
        const cappedNotice =
          block.isCapped && block.originalBytes !== undefined
            ? t("agentStream.messageCapped", { bytes: block.originalBytes })
            : null;

        return (
          <View key={block.id} style={[styles.block, index > 0 && styles.blockSeparator]}>
            {hasHeader ? (
              <View style={styles.header}>
                {block.heading ? (
                  <Text style={styles.heading} numberOfLines={preview ? 1 : undefined}>
                    {block.heading}
                  </Text>
                ) : null}
                {block.meta ? (
                  <Text style={styles.meta} numberOfLines={preview ? 1 : undefined}>
                    {block.meta}
                  </Text>
                ) : null}
              </View>
            ) : null}

            {renderBlockContent(block, preview, cappedNotice)}
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
  heading: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  meta: {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
    maxWidth: "70%",
  },
  proseContainer: {
    minWidth: 0,
  },
  code: {
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
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  truncatedNotice: {
    marginTop: theme.spacing[1],
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
