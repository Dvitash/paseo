import type { ComposerAttachment } from "@/attachments/types";
import type { InlineImageTextStore } from "@/composer/inline-images";

export interface InlineImageOverlayProps {
  /** Live editor text (updates on every keystroke, before draft publication). */
  textStore: InlineImageTextStore;
  /** Returns the underlying textarea element the overlay mirrors. */
  getTextarea: () => HTMLElement | null;
  attachments: readonly ComposerAttachment[];
  onOpenAttachment?: (attachment: ComposerAttachment) => void;
  onRemoveAttachment?: (attachment: ComposerAttachment) => void;
}
