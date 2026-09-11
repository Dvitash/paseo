import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import {
  buildInlineImageToken,
  createInlineImageTextStore,
  type InlineImageTextStore,
} from "@/composer/inline-images";
import { InlineImageOverlay } from "./inline-image-overlay.web";

interface MountedOverlay {
  root: Root;
  container: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  store: InlineImageTextStore;
}

const mounted: MountedOverlay[] = [];

function noopAttachment() {}

const textareaHolder: { current: HTMLTextAreaElement | null } = { current: null };
function getHeldTextarea() {
  return textareaHolder.current;
}

const attachmentActionLog: { opened: string | null; removed: string | null } = {
  opened: null,
  removed: null,
};
function recordOpened(a: ComposerAttachment) {
  attachmentActionLog.opened = a.kind === "image" ? a.metadata.id : null;
}
function recordRemoved(a: ComposerAttachment) {
  attachmentActionLog.removed = a.kind === "image" ? a.metadata.id : null;
}

function imageAttachment(id: string): ComposerAttachment {
  const metadata: AttachmentMetadata = {
    id,
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: `key-${id}`,
    fileName: `${id}.png`,
    createdAt: 0,
  };
  return { kind: "image", metadata };
}

function mountOverlay(initialText: string, attachments: ComposerAttachment[]): MountedOverlay {
  const container = document.createElement("div");
  container.style.position = "relative";
  container.style.width = "320px";
  document.body.appendChild(container);

  const textarea = document.createElement("textarea");
  textarea.style.fontFamily = "monospace";
  textarea.style.fontSize = "14px";
  textarea.style.lineHeight = "20px";
  textarea.style.padding = "8px";
  textarea.style.width = "100%";
  textarea.style.boxSizing = "border-box";
  textarea.value = initialText;
  container.appendChild(textarea);
  textareaHolder.current = textarea;

  const store = createInlineImageTextStore(initialText);
  const reactRoot = document.createElement("div");
  container.appendChild(reactRoot);
  const root = createRoot(reactRoot);
  act(() => {
    root.render(
      <InlineImageOverlay
        textStore={store}
        getTextarea={getHeldTextarea}
        attachments={attachments}
        onOpenAttachment={noopAttachment}
        onRemoveAttachment={noopAttachment}
      />,
    );
  });

  const entry = { root, container, textarea, store };
  mounted.push(entry);
  return entry;
}

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop();
    if (!entry) break;
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("InlineImageOverlay", () => {
  it("renders a pill marker over a resolved token", () => {
    const attachment = imageAttachment("att_abc12345");
    const token = buildInlineImageToken("att_abc12345");
    const { container } = mountOverlay(`hello ${token} world`, [attachment]);

    const marker = container.querySelector<HTMLElement>(
      `[data-inline-image="${attachment.kind === "image" ? attachment.metadata.id : ""}"]`,
    );
    expect(marker).not.toBeNull();
    expect(marker?.textContent).toContain(token);
  });

  it("does not render a pill for unresolved tokens", () => {
    const { container } = mountOverlay("hello [image:deadbeef] world", []);
    expect(container.querySelector("[data-inline-image]")).toBeNull();
  });

  it("updates when the live text store changes", () => {
    const attachment = imageAttachment("att_abc12345");
    const token = buildInlineImageToken("att_abc12345");
    const { container, store } = mountOverlay("no tokens yet", [attachment]);
    expect(container.querySelector("[data-inline-image]")).toBeNull();

    act(() => {
      store.set(`now ${token} inline`);
    });
    expect(container.querySelector("[data-inline-image]")).not.toBeNull();
  });

  it("positions the marker where the token text sits", () => {
    const attachment = imageAttachment("att_abc12345");
    const token = buildInlineImageToken("att_abc12345");
    const { container, textarea } = mountOverlay(`hi ${token} yo`, [attachment]);

    const marker = container.querySelector<HTMLElement>("[data-inline-image]");
    expect(marker).not.toBeNull();
    const markerRect = marker!.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    // The marker should sit inside the textarea's box, to the right of "hi ".
    expect(markerRect.top).toBeGreaterThanOrEqual(textareaRect.top);
    expect(markerRect.left).toBeGreaterThan(textareaRect.left);
    expect(markerRect.width).toBeGreaterThan(0);
  });

  it("opens on click and removes via the close button", () => {
    const attachment = imageAttachment("att_abc12345");
    const token = buildInlineImageToken("att_abc12345");
    attachmentActionLog.opened = null;
    attachmentActionLog.removed = null;

    const container = document.createElement("div");
    container.style.position = "relative";
    document.body.appendChild(container);
    const textarea = document.createElement("textarea");
    textarea.value = `x ${token}`;
    container.appendChild(textarea);
    textareaHolder.current = textarea;
    const store = createInlineImageTextStore(textarea.value);
    const reactRoot = document.createElement("div");
    container.appendChild(reactRoot);
    const root = createRoot(reactRoot);
    act(() => {
      root.render(
        <InlineImageOverlay
          textStore={store}
          getTextarea={getHeldTextarea}
          attachments={[attachment]}
          onOpenAttachment={recordOpened}
          onRemoveAttachment={recordRemoved}
        />,
      );
    });
    mounted.push({ root, container, textarea, store });

    const marker = container.querySelector<HTMLElement>("[data-inline-image]")!;
    // The marker is a non-interactive container; Open is a real button child.
    // No i18n init in this test — t() returns the key.
    const open = marker.querySelector<HTMLButtonElement>(
      'button[aria-label="composer.attachments.openImage"]',
    )!;
    act(() => {
      open.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(attachmentActionLog.opened).toBe("att_abc12345");

    const close = marker.querySelector<HTMLButtonElement>(
      'button[aria-label="composer.attachments.removeImage"]',
    )!;
    act(() => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(attachmentActionLog.removed).toBe("att_abc12345");
  });
});
