import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useSyncExternalStore,
} from "react";
import { X } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import type { ComposerAttachment } from "@/attachments/types";
import { useAttachmentPreviewUrl } from "@/attachments/use-attachment-preview-url";
import { findInlineImageTokens, resolveInlineImageToken } from "@/composer/inline-images";
import { useTranslation } from "react-i18next";
import type { InlineImageOverlayProps } from "./inline-image-overlay.types";

const ThemedX = withUnistyles(X);
const iconForegroundMutedMapping = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

/**
 * Mirrors the textarea's text layout so each `[image:CODE]` token gets a pill
 * rendered exactly on top of it. The textarea keeps the raw token text, which
 * keeps caret positions, wrapping, and height measurement identical to the
 * mirror — the pill is sized by the token's own inline box.
 *
 * The mirror text is `visibility: hidden`; marker spans re-enable visibility
 * for themselves (background = pill body) while their token text stays hidden
 * inside a nested hidden span. Pointer events pass through everywhere except
 * the markers, so text selection and caret placement are untouched.
 */

const MIRRORED_TEXT_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "whiteSpace",
  "overflowWrap",
  "wordWrap",
  "wordBreak",
  "lineBreak",
  "tabSize",
  "direction",
  "boxSizing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
] as const;

const OVERLAY_STYLE: React.CSSProperties = {
  position: "absolute",
  overflow: "hidden",
  pointerEvents: "none",
  zIndex: 1,
};

const CONTENT_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  visibility: "hidden",
  pointerEvents: "none",
  margin: 0,
  background: "transparent",
};

const MARKER_STYLE: React.CSSProperties = {
  position: "relative",
  visibility: "visible",
  pointerEvents: "auto",
  background: "var(--colors-surface2)",
  borderRadius: 6,
  boxShadow: "inset 0 0 0 1px var(--colors-border-accent)",
};

const TOKEN_TEXT_STYLE: React.CSSProperties = {
  visibility: "hidden",
};

const PILL_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 3,
  padding: "0 3px",
  overflow: "hidden",
  borderRadius: "inherit",
};

// The open target is a real button so keyboard/AT users can activate it; it
// stretches over the pill body and inherits the pill layout for its contents.
const OPEN_BUTTON_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  gap: 3,
  flex: 1,
  minWidth: 0,
  border: "none",
  padding: 0,
  margin: 0,
  background: "transparent",
  cursor: "default",
  textAlign: "left",
};

const THUMBNAIL_STYLE: React.CSSProperties = {
  width: 16,
  height: 16,
  borderRadius: 3,
  objectFit: "cover",
  flexShrink: 0,
  display: "block",
};

const THUMBNAIL_PLACEHOLDER_STYLE: React.CSSProperties = {
  ...THUMBNAIL_STYLE,
  background: "var(--colors-surface4)",
};

const LABEL_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 11,
  lineHeight: 1,
  color: "var(--colors-foreground-muted)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const CLOSE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  flexShrink: 0,
  border: "none",
  padding: 0,
  margin: 0,
  background: "transparent",
  borderRadius: 3,
  cursor: "pointer",
  color: "var(--colors-foreground-muted)",
};

interface InlineImageMarkerProps {
  attachment: Extract<ComposerAttachment, { kind: "image" }>;
  tokenText: string;
  onOpenAttachment: ((attachment: ComposerAttachment) => void) | undefined;
  onRemoveAttachment: ((attachment: ComposerAttachment) => void) | undefined;
}

function InlineImageMarker({
  attachment,
  tokenText,
  onOpenAttachment,
  onRemoveAttachment,
}: InlineImageMarkerProps) {
  const { t } = useTranslation();
  const previewUrl = useAttachmentPreviewUrl(attachment.metadata);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const handleFocus = useCallback(() => setFocusWithin(true), []);
  const handleBlur = useCallback((event: React.FocusEvent) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setFocusWithin(false);
    }
  }, []);
  const keepFocus = useCallback((event: React.MouseEvent) => {
    // Keep the textarea focused; the pill is a click target, not a caret move.
    event.preventDefault();
  }, []);
  const handleRemoveClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onRemoveAttachment?.(attachment);
    },
    [attachment, onRemoveAttachment],
  );
  const handleOpen = useCallback(() => {
    onOpenAttachment?.(attachment);
  }, [attachment, onOpenAttachment]);
  const closeStyle = useMemo<React.CSSProperties>(
    () => ({
      ...CLOSE_STYLE,
      visibility: hovered || focusWithin ? "visible" : "hidden",
    }),
    [hovered, focusWithin],
  );
  const label = attachment.metadata.fileName ?? "image";
  // The marker is a non-interactive positioned container; Open and Remove are
  // sibling native buttons so neither nests inside the other's interactive
  // semantics. Remove reveals on hover or when focus lands inside the marker.
  return (
    <span
      data-inline-image={attachment.metadata.id}
      className="inline-image-marker"
      style={MARKER_STYLE}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onMouseDown={keepFocus}
    >
      <span style={TOKEN_TEXT_STYLE}>{tokenText}</span>
      <span style={PILL_STYLE}>
        <button
          type="button"
          aria-label={t("composer.attachments.openImage")}
          style={OPEN_BUTTON_STYLE}
          onMouseDown={keepFocus}
          onClick={handleOpen}
        >
          {previewUrl ? (
            <img src={previewUrl} alt="" style={THUMBNAIL_STYLE} draggable={false} />
          ) : (
            <span style={THUMBNAIL_PLACEHOLDER_STYLE} />
          )}
          <span style={LABEL_STYLE}>{label}</span>
        </button>
        <button
          type="button"
          aria-label={t("composer.attachments.removeImage")}
          className="inline-image-remove"
          style={closeStyle}
          onMouseDown={keepFocus}
          onClick={handleRemoveClick}
        >
          <ThemedX size={10} uniProps={iconForegroundMutedMapping} />
        </button>
      </span>
    </span>
  );
}

export function InlineImageOverlay(props: InlineImageOverlayProps) {
  const { textStore, getTextarea, attachments, onOpenAttachment, onRemoveAttachment } = props;
  const text = useSyncExternalStore(textStore.subscribe, textStore.get);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const syncLayout = useCallback(() => {
    const textarea = getTextarea();
    const overlay = overlayRef.current;
    const content = contentRef.current;
    if (!textarea || !overlay || !content) return;

    overlay.style.top = `${textarea.offsetTop}px`;
    overlay.style.left = `${textarea.offsetLeft}px`;
    overlay.style.width = `${textarea.offsetWidth}px`;
    overlay.style.height = `${textarea.offsetHeight}px`;

    const computed = window.getComputedStyle(textarea);
    for (const property of MIRRORED_TEXT_STYLES) {
      content.style[property] = computed[property];
    }
    content.style.width = `${textarea.clientWidth}px`;
    content.style.transform = `translateY(${-textarea.scrollTop}px)`;
  }, [getTextarea]);

  // Runs after every commit: text changes re-wrap the mirror, and style/geometry
  // copying stays in lockstep with the textarea without a React subscription.
  useLayoutEffect(() => {
    syncLayout();
  });

  useLayoutEffect(() => {
    const textarea = getTextarea();
    if (!textarea) return;
    const handleScroll = () => {
      const content = contentRef.current;
      if (content) content.style.transform = `translateY(${-textarea.scrollTop}px)`;
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncLayout);
    observer?.observe(textarea);
    textarea.addEventListener("scroll", handleScroll);
    return () => {
      observer?.disconnect();
      textarea.removeEventListener("scroll", handleScroll);
    };
  }, [getTextarea, syncLayout]);

  const tokens = findInlineImageTokens(text);
  const segments: React.ReactNode[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const attachment = resolveInlineImageToken(token, attachments);
    if (!attachment) continue;
    if (token.start > cursor) {
      segments.push(<span key={`t${cursor}`}>{text.slice(cursor, token.start)}</span>);
    }
    segments.push(
      <InlineImageMarker
        key={`${token.start}:${attachment.metadata.id}`}
        attachment={attachment}
        tokenText={text.slice(token.start, token.end)}
        onOpenAttachment={onOpenAttachment}
        onRemoveAttachment={onRemoveAttachment}
      />,
    );
    cursor = token.end;
  }
  if (cursor < text.length) {
    segments.push(<span key={`t${cursor}`}>{text.slice(cursor)}</span>);
  }

  return (
    <div ref={overlayRef} style={OVERLAY_STYLE} aria-hidden={false}>
      <div ref={contentRef} style={CONTENT_STYLE}>
        {segments}
      </div>
    </div>
  );
}
