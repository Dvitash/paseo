import type { InlineImageOverlayProps } from "./inline-image-overlay.types";

/**
 * Inline image pills only exist on web, where the overlay can mirror the
 * textarea. Native keeps the raw `[image:CODE]` token text plus the regular
 * attachment tray.
 */
export function InlineImageOverlay(_props: InlineImageOverlayProps): null {
  return null;
}
