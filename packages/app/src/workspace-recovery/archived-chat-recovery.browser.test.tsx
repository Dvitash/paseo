import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import "@/i18n/i18next";
import { ArchivedChatRecovery } from "./archived-chat-recovery";

const mocks = vi.hoisted(() => ({
  client: { fetchAgentTimeline: vi.fn(), buildAgentForkContext: vi.fn() },
  supported: true,
  navigate: vi.fn(),
  state: { sessions: { host: { workspaces: new Map() } } },
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => mocks.client,
  useHostRuntimeIsConnected: () => true,
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => mocks.supported }));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: mocks.navigate,
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state },
  ),
}));

let root: Root | null = null;
let container: HTMLDivElement;
let queries: QueryClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.supported = true;
  mocks.client.fetchAgentTimeline.mockResolvedValue({
    agent: { provider: "omp", cwd: "/gone", title: "Saved discussion" },
    entries: [
      {
        seqStart: 1,
        seqEnd: 1,
        item: { type: "user_message", text: "Remember the original task" },
      },
    ],
    hasOlder: false,
    startCursor: { epoch: "saved", seq: 1 },
    error: null,
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  queries = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root = createRoot(container);
});
afterEach(() => {
  act(() => root?.unmount());
  queries.clear();
  container.remove();
});
function render() {
  act(() =>
    root!.render(
      <QueryClientProvider client={queries}>
        <ArchivedChatRecovery serverId="host" workspaceId="archived" agentId="chat" />
      </QueryClientProvider>,
    ),
  );
}
function click(id: string) {
  const element = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  if (!element) throw new Error(`Missing action: ${id}`);
  act(() => element.click());
}

test("viewing history is explicit and read-only, even after restore failure", async () => {
  render();
  expect(mocks.client.fetchAgentTimeline).not.toHaveBeenCalled();
  click("view-saved-chat");
  await vi.waitFor(() => expect(document.body.textContent).toContain("Remember the original task"));
  expect(mocks.client.fetchAgentTimeline).toHaveBeenCalledWith(
    "chat",
    expect.objectContaining({ savedOnly: true }),
  );
  expect(mocks.client.buildAgentForkContext).not.toHaveBeenCalled();
  expect(mocks.navigate).not.toHaveBeenCalled();
  expect(document.querySelector("textarea")).toBeNull();
});

test("history failure renders in place instead of pretending the chat was recovered", async () => {
  mocks.client.fetchAgentTimeline.mockRejectedValue(new Error("Saved transcript is missing"));
  render();
  click("view-saved-chat");
  await vi.waitFor(() =>
    expect(
      document.querySelector('[data-testid="saved-chat-history-error"]')?.textContent,
    ).toContain("Saved transcript is missing"),
  );
  expect(mocks.navigate).not.toHaveBeenCalled();
});

test("older hosts do not expose actions that could start an archived agent", () => {
  mocks.supported = false;
  render();
  expect(document.querySelector('[data-testid="view-saved-chat"]')).toBeNull();
  expect(mocks.client.fetchAgentTimeline).not.toHaveBeenCalled();
});
