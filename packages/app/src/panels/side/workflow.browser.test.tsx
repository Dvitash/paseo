import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SideChatSnapshot } from "@getpaseo/protocol/side";
import { SideChatView } from "../side-panel";
import { useSideWorkspaceStore, sideSessionKey } from "./state";
import { readSideSelection } from "./selection.web";

const mounted: { root: Root; container: HTMLDivElement; queries: QueryClient }[] = [];
function emptySnapshot(mainAgentId = "main"): SideChatSnapshot {
  return {
    mainAgentId,
    sideAgentId: null,
    status: "idle",
    error: null,
    messages: [],
    steeringProposal: null,
    provider: "claude",
    model: "main-model",
    supportedProviders: ["claude", "codex"],
    conversationId: `unstarted:${mainAgentId}`,
    revision: 0,
  };
}
function fixture(initial = emptySnapshot(), width = 390) {
  const client = new DaemonClient({ url: "ws://127.0.0.1:1", clientId: "side-browser-test" });
  const listeners = new Map<string, (snapshot: SideChatSnapshot) => void>();
  let current = initial;
  vi.spyOn(client, "isConnected", "get").mockReturnValue(true);
  vi.spyOn(client, "subscribeConnectionStatus").mockReturnValue(() => undefined);
  const subscription = vi.spyOn(client, "subscribeSideChat").mockImplementation((id, next) => {
    listeners.set(id, next);
    next(current);
    return () => {
      listeners.delete(id);
    };
  });
  const refresh = vi.spyOn(client, "refreshSideChat").mockImplementation(async (id) => {
    listeners.get(id)?.(current);
  });
  vi.spyOn(client, "listProviderModels").mockResolvedValue({
    provider: "codex",
    requestId: "models-request",
    fetchedAt: "2026-09-16T01:00:00Z",
    models: [{ provider: "codex", id: "fast-model", label: "Fast model" }],
    error: null,
  });
  const send = vi.spyOn(client, "sendSideChat").mockImplementation(async (id, text, options) => {
    current = {
      ...current,
      mainAgentId: id,
      sideAgentId: "side-agent",
      provider: options?.provider,
      model: options?.model,
      conversationId: "conversation",
      revision: 1,
      messages: [
        { id: options?.clientMessageId ?? "message", role: "user", text, action: options?.action },
      ],
    };
    return current;
  });
  const steer = vi
    .spyOn(client, "steerSideChat")
    .mockImplementation(async (id, proposalId, text) => {
      current = {
        ...current,
        messages: current.messages.map((message) =>
          message.proposal?.id === proposalId
            ? {
                ...message,
                proposal: {
                  ...message.proposal,
                  delivery: {
                    messageId: "delivery",
                    text,
                    status: "delivered",
                    updatedAt: "2026-09-16T01:00:00Z",
                    error: null,
                  },
                },
              }
            : message,
        ),
      };
      return current;
    });
  const container = document.createElement("div");
  container.style.cssText = `display:flex;flex-direction:column;width:${width}px;height:720px;position:fixed;top:0;left:0`;
  document.body.appendChild(container);
  const root = createRoot(container);
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function render(id = current.mainAgentId, active = true) {
    act(() =>
      root.render(
        <QueryClientProvider client={queries}>
          <SideChatView
            key={id}
            serverId="host"
            mainAgentId={id}
            mainAgentTitle={id}
            mainAgentProvider="claude"
            client={client}
            isActive={active}
          />
        </QueryClientProvider>,
      ),
    );
  }
  mounted.push({ root, container, queries });
  render();
  return {
    container,
    client,
    send,
    steer,
    refresh,
    subscription,
    render,
    emit: (snapshot: SideChatSnapshot) => {
      current = snapshot;
      act(() => listeners.get(snapshot.mainAgentId)?.(snapshot));
    },
  };
}
function input(container: HTMLElement, testId = "side-input"): HTMLTextAreaElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLTextAreaElement)) throw new Error(`Missing textarea ${testId}`);
  return element;
}
function typeText(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("Textarea setter missing");
  act(() => {
    setter.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
  });
}
function click(container: HTMLElement, testId: string) {
  const button = container.querySelector(`[data-testid="${testId}"]`);
  if (!(button instanceof HTMLElement)) throw new Error(`Missing button ${testId}`);
  act(() => button.click());
}
beforeEach(() =>
  useSideWorkspaceStore.setState({ drafts: {}, pins: {}, lastMain: {}, proposalDrafts: {} }),
);
afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
    entry.queries.clear();
  }
  vi.restoreAllMocks();
});

describe("Side user workflow", () => {
  it("sends the selected provider and model, and fits a mobile-width composer", async () => {
    useSideWorkspaceStore
      .getState()
      .updateDraft(sideSessionKey("host", "main"), { provider: "codex", model: "fast-model" });
    const view = fixture();
    await vi.waitFor(() => expect(view.container.textContent).toContain("fast-model"));
    const textarea = input(view.container);
    expect(textarea.getBoundingClientRect().width).toBeGreaterThan(320);
    expect(textarea.getBoundingClientRect().right).toBeLessThanOrEqual(
      view.container.getBoundingClientRect().right,
    );
    typeText(textarea, "Verify the parser");
    click(view.container, "side-send-button");
    await vi.waitFor(() =>
      expect(view.send).toHaveBeenCalledWith(
        "main",
        "Verify the parser",
        expect.objectContaining({
          provider: "codex",
          model: "fast-model",
          clientMessageId: expect.any(String),
        }),
      ),
    );
    await vi.waitFor(() => expect(input(view.container).value).toBe(""));
  });
  it("refreshes an idle chat on PWA foreground and keeps separate drafts on session switches", async () => {
    const view = fixture();
    typeText(input(view.container), "Draft A");
    view.render("other");
    typeText(input(view.container), "Draft B");
    view.render("main");
    expect(input(view.container).value).toBe("Draft A");
    const before = view.refresh.mock.calls.length;
    act(() => window.dispatchEvent(new Event("pageshow")));
    await vi.waitFor(() => expect(view.refresh.mock.calls.length).toBeGreaterThan(before));
    expect(view.refresh).toHaveBeenLastCalledWith("main");
  });
  it("retains a proposal-only message and persists delivery confirmation after remount", async () => {
    const snapshot = {
      ...emptySnapshot(),
      sideAgentId: "side",
      conversationId: "conversation",
      messages: [
        {
          id: "proposal-message",
          role: "assistant" as const,
          text: "",
          proposal: {
            id: "proposal",
            mainAgentId: "main",
            text: "Run the parser tests",
            createdAt: "2026-09-16T01:00:00Z",
            delivery: null,
          },
        },
      ],
    };
    const view = fixture(snapshot);
    await vi.waitFor(() => expect(view.container.textContent).toContain("Proposed steering"));
    expect(view.container.textContent).not.toContain("<steer_proposal>");
    typeText(input(view.container, "side-steering-input"), "Run only the parser tests");
    click(view.container, "side-steering-send-button");
    await vi.waitFor(() =>
      expect(view.steer).toHaveBeenCalledWith("main", "proposal", "Run only the parser tests"),
    );
    await vi.waitFor(() => expect(view.container.textContent).toContain("Delivery confirmed"));
    view.render("other");
    view.render("main");
    await vi.waitFor(() =>
      expect(view.container.textContent).toContain("not yet verified as implemented"),
    );
    expect(view.container.querySelector('[data-testid="side-steering-send-button"]')).toBeNull();
  });
  it("does not hijack scroll position while a new message streams", async () => {
    const messages = Array.from({ length: 25 }, (_, index) => ({
      id: `message-${index}`,
      role: "assistant" as const,
      text: `Paragraph ${index}: ${"A sufficiently long explanation. ".repeat(10)}`,
    }));
    const snapshot = {
      ...emptySnapshot(),
      sideAgentId: "side",
      conversationId: "scroll-test",
      messages,
    };
    const view = fixture(snapshot, 440);
    await vi.waitFor(() => expect(view.container.textContent).toContain("Paragraph 24"));
    const scroller = Array.from(view.container.querySelectorAll("div")).find(
      (element) =>
        getComputedStyle(element).overflowY === "auto" ||
        getComputedStyle(element).overflowY === "scroll",
    );
    if (!scroller) throw new Error("Transcript scroller missing");
    await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight));
    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await new Promise((resolve) => setTimeout(resolve, 160));
    view.emit({
      ...snapshot,
      revision: 2,
      messages: [...messages, { id: "new", role: "assistant", text: "New streamed output" }],
    });
    await vi.waitFor(() =>
      expect(view.container.querySelector('[data-testid="side-new-response"]')).not.toBeNull(),
    );
    expect(scroller.scrollTop).toBe(0);
  });
});

describe("Side source selection", () => {
  it("preserves exact whitespace and rejects selections outside the source scope", () => {
    const scope = document.createElement("pre");
    scope.id = "side-selection-fixture";
    scope.textContent = "  const value = 1;\n    return value;\n";
    const outside = document.createElement("p");
    outside.textContent = "Not part of the linked source";
    document.body.append(scope, outside);
    const selection = window.getSelection();
    if (!selection || !scope.firstChild) throw new Error("DOM selection unavailable");
    try {
      const range = document.createRange();
      range.selectNodeContents(scope);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(readSideSelection(scope.id)).toBe(scope.textContent);
      range.selectNodeContents(outside);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(readSideSelection(scope.id)).toBeNull();
    } finally {
      selection.removeAllRanges();
      scope.remove();
      outside.remove();
    }
  });
});
