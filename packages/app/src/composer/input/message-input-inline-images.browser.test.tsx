/* oxlint-disable eslint-plugin-react-perf/jsx-no-new-function-as-prop, eslint-plugin-react-perf/jsx-no-new-object-as-prop -- test harness props are per-mount fixtures, not render-loop allocations */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import type { AttachmentMetadata, ComposerAttachment } from "@/attachments/types";
import type { DaemonClient } from "@getpaseo/client";
import type { ImageAttachment } from "@/composer/types";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { ComposerKeyboardScopeProvider } from "@/composer/keyboard-scope";
import { buildInlineImageToken } from "@/composer/inline-images";
import { MessageInput, type MessageInputRef } from "./input";

const { asyncStorage } = vi.hoisted(() => ({
  asyncStorage: new Map<string, string>(),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => asyncStorage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      asyncStorage.set(key, value);
    },
    removeItem: async (key: string) => {
      asyncStorage.delete(key);
    },
  },
}));

const persistedAttachments = vi.hoisted(() => ({
  nextId: 0,
  saved: [] as AttachmentMetadata[],
}));

vi.mock("@/attachments/service", () => ({
  persistAttachmentFromBlob: async (input: { fileName?: string; mimeType: string }) => {
    persistedAttachments.nextId += 1;
    const id = `att_paste${persistedAttachments.nextId}`;
    const metadata: AttachmentMetadata = {
      id,
      mimeType: input.mimeType,
      storageType: "web-indexeddb",
      storageKey: `key-${id}`,
      fileName: input.fileName ?? "pasted.png",
      createdAt: 0,
    };
    persistedAttachments.saved.push(metadata);
    return metadata;
  },
  garbageCollectAttachments: async () => undefined,
  persistAttachmentFromDataUrl: async () => {
    throw new Error("not implemented in test");
  },
  persistAttachmentFromBytes: async () => {
    throw new Error("not implemented in test");
  },
  persistAttachmentFromFileUri: async () => {
    throw new Error("not implemented in test");
  },
  encodeAttachmentsForSend: async () => [],
  resolveAttachmentPreviewUrl: async () => "blob:preview",
  releaseAttachmentPreviewUrl: async () => undefined,
  deleteAttachments: async () => undefined,
}));

const toastApi = vi.hoisted(
  (): ToastApi => ({
    show: () => {},
    copied: () => {},
    error: () => {},
  }),
);

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => toastApi,
  ToastApiProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const i18n = createInstance();
await i18n.init({
  lng: "en",
  resources: {
    en: {
      translation: {
        composer: {
          inputPlaceholder: "Message",
          attachments: {
            openImage: "Open image",
            removeImage: "Remove image",
          },
        },
      },
    },
  },
});
const connectedClient = {
  isConnected: true,
  subscribeRawMessages: () => () => {},
  subscribeConnectionStatus: () => () => {},
  on: () => () => {},
} as unknown as DaemonClient;

interface ComposerState {
  value: string;
  attachments: ComposerAttachment[];
  rerender: () => void;
}

interface MountedComposer {
  root: Root;
  container: HTMLDivElement;
  textarea: HTMLTextAreaElement;
  inputRef: React.MutableRefObject<MessageInputRef | null>;
  state: ComposerState;
}

const mounted: MountedComposer[] = [];
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function noop() {}
function noopAttachment(_attachment: ComposerAttachment) {}
function noopAttachments(_attachments: ComposerAttachment[]) {}
function noopImages(_images: ImageAttachment[]) {}

interface HarnessProps {
  state: ComposerState;
  inputRef: React.MutableRefObject<MessageInputRef | null>;
  onAddImages?: (images: ImageAttachment[]) => void;
  onOpenAttachment?: (attachment: ComposerAttachment) => void;
  onRemoveAttachments?: (attachments: ComposerAttachment[]) => void;
}

function Harness(props: HarnessProps) {
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);
  props.state.rerender = forceRender;
  return (
    <MessageInput
      ref={props.inputRef}
      value={props.state.value}
      onChangeText={(text) => {
        props.state.value = text;
        forceRender();
      }}
      onSubmit={noop}
      attachments={props.state.attachments}
      cwd="/tmp"
      attachmentMenuItems={[]}
      textReplacement={{ key: "test", text: "" }}
      client={connectedClient}
      defaultSendBehavior="interrupt"
      onAddImages={props.onAddImages ?? noopImages}
      onOpenAttachment={props.onOpenAttachment ?? noopAttachment}
      onRemoveAttachments={props.onRemoveAttachments ?? noopAttachments}
    />
  );
}

function mountComposer(options?: {
  value?: string;
  attachments?: ComposerAttachment[];
  onAddImages?: (images: ImageAttachment[]) => void;
  onOpenAttachment?: (attachment: ComposerAttachment) => void;
  onRemoveAttachments?: (attachments: ComposerAttachment[]) => void;
}): MountedComposer {
  const container = document.createElement("div");
  container.style.width = "480px";
  document.body.appendChild(container);
  const root = createRoot(container);
  const inputRef: React.MutableRefObject<MessageInputRef | null> = { current: null };
  const state = {
    value: options?.value ?? "",
    attachments: options?.attachments ?? [],
    rerender: noop,
  };

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <ToastApiProvider api={toastApi}>
            <ComposerKeyboardScopeProvider isActiveComposer={true}>
              <Harness
                state={state}
                inputRef={inputRef}
                onAddImages={options?.onAddImages}
                onOpenAttachment={options?.onOpenAttachment}
                onRemoveAttachments={options?.onRemoveAttachments}
              />
            </ComposerKeyboardScopeProvider>
          </ToastApiProvider>
        </I18nextProvider>
      </QueryClientProvider>,
    );
  });

  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("MessageInput did not render a textarea");
  const entry = { root, container, textarea, inputRef, state };
  mounted.push(entry);
  return entry;
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

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

function dispatchPaste(textarea: HTMLTextAreaElement, file: File): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: [
        {
          kind: "file",
          type: file.type,
          getAsFile: () => file,
        },
      ],
    },
  });
  textarea.dispatchEvent(event);
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// IndexedDB persistence resolves on macrotasks, so poll with real timers.
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await act(() => promise);
  }
}

describe("MessageInput inline images", () => {
  it("inserts a token at the caret on paste and renders an inline pill", async () => {
    const added: ImageAttachment[][] = [];
    const composer = mountComposer({
      value: "hello ",
      onAddImages: (images) => {
        added.push(images);
        // Tokens are inserted/settled by the input itself; the parent only
        // registers the attachments so the tokens resolve.
        composer.state.attachments = [
          ...composer.state.attachments,
          ...images.map((metadata) => ({ kind: "image" as const, metadata })),
        ];
        composer.state.rerender();
      },
    });

    composer.textarea.focus();
    composer.textarea.setSelectionRange(6, 6);
    const file = new File(["1234"], "shot.png", { type: "image/png" });
    dispatchPaste(composer.textarea, file);
    await waitFor(() => added.length === 1);

    const id = added[0]![0]!.id;
    const token = buildInlineImageToken(id, "shot.png");
    expect(composer.textarea.value).toBe(`hello ${token}`);
    expect(composer.textarea.selectionStart).toBe(6 + token.length);
    const marker = composer.container.querySelector<HTMLElement>("[data-inline-image]");
    expect(marker).not.toBeNull();
    const markerRect = marker!.getBoundingClientRect();
    const textareaRect = composer.textarea.getBoundingClientRect();
    expect(markerRect.top).toBeGreaterThanOrEqual(textareaRect.top);
    expect(markerRect.left).toBeGreaterThan(textareaRect.left);
  });

  it("opens the attachment on pill click and removes it via the close button", async () => {
    const attachment = imageAttachment("att_abc12345");
    const token = buildInlineImageToken("att_abc12345");
    let opened: string | null = null;
    let removed: string | null = null;
    const composer = mountComposer({
      value: `x ${token}`,
      attachments: [attachment],
      onOpenAttachment: (a) => {
        opened = a.kind === "image" ? a.metadata.id : null;
      },
      onRemoveAttachments: (list) => {
        const a = list[0];
        removed = a?.kind === "image" ? a.metadata.id : null;
      },
    });
    await flush();

    const marker = composer.container.querySelector<HTMLElement>("[data-inline-image]")!;
    expect(marker).not.toBeNull();
    // The marker is a non-interactive container; Open is a real button child.
    const open = marker.querySelector<HTMLButtonElement>('button[aria-label="Open image"]')!;
    act(() => {
      open.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(opened).toBe("att_abc12345");

    const close = marker.querySelector<HTMLButtonElement>('button[aria-label="Remove image"]')!;
    act(() => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(removed).toBe("att_abc12345");
    // The token leaves the draft too — no dead `[image:…]` text remains.
    expect(composer.textarea.value).toBe("x ");
    expect(composer.state.value).toBe("x ");
    expect(composer.container.querySelector("[data-inline-image]")).toBeNull();
  });

  it("backspace at the token end deletes the whole token", async () => {
    const attachment = imageAttachment("att_abc12345");
    const token = buildInlineImageToken("att_abc12345");
    const composer = mountComposer({
      value: `x ${token} y`,
      attachments: [attachment],
    });
    await flush();

    const tokenEnd = 2 + token.length;
    composer.textarea.focus();
    act(() => {
      composer.textarea.setSelectionRange(tokenEnd, tokenEnd);
      composer.textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      );
    });

    expect(composer.textarea.value).toBe("x  y");
    expect(composer.state.value).toBe("x  y");
    expect(composer.container.querySelector("[data-inline-image]")).toBeNull();
  });
});
