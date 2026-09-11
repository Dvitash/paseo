import type { ComposerAttachment } from "@/attachments/types";
import type { ImageAttachment } from "@/composer/types";
import {
  isWorkspaceAttachment,
  workspaceAttachmentToSubmitAttachment,
} from "@/attachments/workspace-attachment-utils";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import {
  buildForgeAttachmentFromSearchItem,
  buildLegacyGitHubAttachmentFromSearchItem,
} from "@/utils/review-attachments";
import { workspaceFileAttachmentToAgentAttachment } from "@/attachments/workspace-file";
import { pluginResourceAttachmentToAgentAttachment } from "@/plugins/attachments";
import { resolveInlineImageReferences } from "@/composer/inline-images";

export type ComposerAttachmentSubmitFormat = "forge" | "legacy-github";

interface SplitComposerAttachmentsOptions {
  format?: ComposerAttachmentSubmitFormat;
}

export function resolveComposerAttachmentSubmitFormat(input: {
  supportsForgeAttachments?: boolean;
}): ComposerAttachmentSubmitFormat {
  // COMPAT(githubAttachmentKinds): emit legacy GitHub attachments for daemons
  // predating forge-neutral attachments. Remove after 2027-01-17 once the
  // supported daemon floor is >= v0.2.0.
  return input.supportsForgeAttachments === false ? "legacy-github" : "forge";
}

export function splitComposerAttachmentsForSubmit(
  attachments: ComposerAttachment[],
  options: SplitComposerAttachmentsOptions = {},
): {
  images: ImageAttachment[];
  attachments: AgentAttachment[];
} {
  const images: ImageAttachment[] = [];
  const agentAttachments: AgentAttachment[] = [];
  // COMPAT(githubAttachmentKinds): emit legacy GitHub attachments for daemons
  // predating forge-neutral attachments. Remove after 2027-01-17 once the
  // supported daemon floor is >= v0.2.0.
  const buildSearchAttachment =
    options.format === "legacy-github"
      ? buildLegacyGitHubAttachmentFromSearchItem
      : buildForgeAttachmentFromSearchItem;

  for (const attachment of attachments) {
    if (attachment.kind === "image") {
      images.push(attachment.metadata);
      continue;
    }

    if (attachment.kind === "file") {
      agentAttachments.push(attachment.attachment);
      continue;
    }

    if (attachment.kind === "workspace_file") {
      agentAttachments.push(workspaceFileAttachmentToAgentAttachment(attachment));
      continue;
    }

    if (attachment.kind === "plugin_resource") {
      agentAttachments.push(pluginResourceAttachmentToAgentAttachment(attachment));
      continue;
    }

    if (isWorkspaceAttachment(attachment)) {
      if (attachment.kind === "browser_element" && attachment.attachment.screenshot) {
        images.push(attachment.attachment.screenshot);
      }
      const workspaceAttachment = workspaceAttachmentToSubmitAttachment(attachment);
      if (workspaceAttachment) {
        agentAttachments.push(workspaceAttachment);
      }
      continue;
    }

    const reviewAttachment = buildSearchAttachment(attachment.item);
    if (reviewAttachment) {
      agentAttachments.push(reviewAttachment);
    }
  }

  return {
    images,
    attachments: agentAttachments,
  };
}

export interface ComposerWirePayload {
  /** Text with resolvable `[image:…]` tokens rewritten to `[image:N]` wire indices. */
  text: string;
  images: ImageAttachment[];
  attachments: AgentAttachment[];
}

/**
 * Build the wire payload for a composer message: split attachments and resolve
 * inline image tokens to `[image:N]` indices into `images`. Call exactly once
 * per send — token resolution is not idempotent (a resolved `[image:2]` could
 * re-bind to a different attachment on a second pass).
 */
export function buildComposerWirePayload(input: {
  text: string;
  attachments: ComposerAttachment[];
  format?: ComposerAttachmentSubmitFormat;
}): ComposerWirePayload {
  const wirePayload = splitComposerAttachmentsForSubmit(input.attachments, {
    format: input.format,
  });
  return {
    text: resolveInlineImageReferences(input.text, wirePayload.images, input.attachments),
    images: wirePayload.images,
    attachments: wirePayload.attachments,
  };
}

/**
 * `encodeAttachmentsForSend` drops entries that fail to encode, which would
 * silently shift `[image:N]` indices. When the wire text references images by
 * index, require every image to encode — otherwise reject the send so the
 * user can retry instead of delivering a mislabeled prompt.
 */
export function assertComposerWireImagesEncoded(input: {
  text: string;
  images: readonly ImageAttachment[];
  encoded: Array<{ data: string; mimeType: string }> | undefined;
}): void {
  if (!/\[image:\d+\]/.test(input.text)) return;
  const expected = input.images.length;
  const actual = input.encoded?.length ?? 0;
  if (expected > 0 && actual !== expected) {
    throw new Error(
      `Failed to attach ${expected - actual} of ${expected} inline image(s). Please try again.`,
    );
  }
}
