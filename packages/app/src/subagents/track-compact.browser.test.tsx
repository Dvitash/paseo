import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import type * as LayoutModule from "@/constants/layout";
import { SubagentsTrack } from "./track";
import type { PaseoSubagentRow, SubagentRow } from "./select";

/**
 * The browser suite renders at a width where `useIsCompactFormFactor` is false, so the compact
 * pull tab is unreachable there. Pin the form factor instead of the viewport: the breakpoint
 * comes from Unistyles' runtime, which the browser project does not configure.
 */
const compactState = { value: true };

vi.mock("@/constants/layout", async (importOriginal) => ({
  ...(await importOriginal<typeof LayoutModule>()),
  useIsCompactFormFactor: () => compactState.value,
}));

beforeEach(() => {
  compactState.value = true;
  vi.stubGlobal("React", React);
});

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
}

/** Re-render the last mounted tree, the way a breakpoint change does through the real hook. */
function rerenderTrack(rows: SubagentRow[]): void {
  const entry = mounted[mounted.length - 1];
  if (!entry) {
    throw new Error("No mounted track to re-render");
  }
  act(() =>
    entry.root.render(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    ),
  );
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

function click(element: Element): void {
  act(() => {
    (element as HTMLElement).click();
  });
}

function createRow(id: string): PaseoSubagentRow {
  return {
    kind: "paseo",
    id,
    provider: "codex",
    title: `Agent ${id}`,
    description: null,
    subtitle: null,
    status: "running",
    turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
    requiresAttention: false,
    createdAt: new Date("2026-04-20T00:00:00.000Z"),
  };
}

function renderTrack(rows: SubagentRow[]): void {
  mount(
    <SubagentsTrack
      serverId="test-server"
      rows={rows}
      onOpenSubagent={vi.fn()}
      onOpenProviderSubagent={vi.fn()}
      onArchiveSubagent={vi.fn()}
    />,
  );
}

function header(): HTMLElement {
  const element = document.querySelector('[data-testid="subagents-track-header"]');
  if (!(element instanceof HTMLElement)) {
    throw new Error("Missing subagents track header");
  }
  return element;
}

function hasRow(): boolean {
  return document.querySelector('[data-testid^="subagents-track-row-"]') !== null;
}

describe("SubagentsTrack compact pull tab", () => {
  beforeEach(async () => {
    if (!i18n.isInitialized) {
      await i18n.init();
    }
    await i18n.changeLanguage("en");
  });

  it("starts collapsed to the header and keeps the count readable", () => {
    renderTrack([createRow("a"), createRow("b")]);

    expect(header().textContent).toContain("Subagents");
    expect(header().textContent).toContain("2 working");
    expect(hasRow()).toBe(false);
  });

  it("reveals the rows when the header is pulled up, and hides them again", () => {
    renderTrack([createRow("a")]);

    click(header());
    expect(hasRow()).toBe(true);
    expect(document.querySelector('[data-testid="subagents-track-row-a"]')?.textContent).toContain(
      "Agent a",
    );

    click(header());
    expect(hasRow()).toBe(false);
  });

  it("exposes the pull state to assistive technology", () => {
    renderTrack([createRow("a")]);

    expect(header().getAttribute("aria-expanded")).toBe("false");
    click(header());
    expect(header().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the live activity on its own line so it does not fight the task for width", () => {
    useSessionStore.getState().initializeSession("test-server", null as unknown as never);
    useSessionStore.getState().setAgentStreamState("test-server", "a", {
      tail: [
        {
          kind: "tool_call",
          id: "t1",
          timestamp: new Date(),
          payload: {
            source: "agent",
            data: {
              provider: "mock",
              callId: "call_1",
              name: "Reading src/subagents/track.tsx",
              status: "running",
              error: null,
              detail: { type: "shell", command: "git status" },
            },
          },
        },
      ],
    });

    renderTrack([createRow("a")]);
    click(header());

    const primary = document.querySelector('[data-testid="subagents-track-row-primary-a"]');
    const activity = document.querySelector('[data-testid="subagents-track-activity-a"]');
    if (!(primary instanceof HTMLElement) || !(activity instanceof HTMLElement)) {
      throw new Error("Expected the row's primary line and a separate activity line");
    }

    expect(primary.textContent).toContain("Agent a");
    expect(activity.textContent).toBe("Reading src/subagents/track.tsx");
    // The activity is a sibling of the line holding the task, so it gets its own full width
    // instead of being squeezed between the task and the elapsed counter.
    expect(primary.contains(activity)).toBe(false);
    const primaryRect = primary.getBoundingClientRect();
    const activityRect = activity.getBoundingClientRect();
    expect(activityRect.top).toBeGreaterThanOrEqual(primaryRect.bottom - 1);
    // Full width: the activity is not sharing a line with the task or the elapsed counter.
    expect(activityRect.width).toBeGreaterThan(150);
  });

  it("gives the pull handle a full touch target when collapsed", () => {
    renderTrack([createRow("a")]);

    expect(header().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
  });

  it("drops the header divider while collapsed, so the bar does not end on a hairline", () => {
    renderTrack([createRow("a")]);
    expect(getComputedStyle(header()).borderBottomWidth).toBe("0px");

    click(header());
    expect(getComputedStyle(header()).borderBottomWidth).not.toBe("0px");
  });

  it("shows the rows again when a collapsed phone rotates to a wide layout", () => {
    const rows = [createRow("a")];
    renderTrack(rows);
    expect(hasRow()).toBe(false);

    // Pull the rows down first: that records an explicit collapsed override, which is what can
    // then outlive the compact form factor. Rotating wide is a form-factor change, not a press —
    // the header stops being a toggle, so a carried-over `true` would leave the rows with no way
    // back.
    click(header());
    click(header());
    expect(hasRow()).toBe(false);

    compactState.value = false;
    rerenderTrack(rows);

    expect(hasRow()).toBe(true);
  });

  it("registers no visible agent timeline while collapsed, and registers on reveal", () => {
    const replaceVisibleAgentIds = vi.fn();
    useSessionStore.getState().initializeSession("test-server", null as unknown as never);
    useSessionStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        "test-server": {
          ...state.sessions["test-server"],
          viewedTimelineSync: {
            subscribe: () => () => undefined,
            replaceVisibleAgentIds,
            getAgentTimelineError: () => null,
            retryVisibleAgentTimeline: vi.fn(),
          } as unknown as never,
        },
      },
    }));

    renderTrack([createRow("a")]);
    const callsWhileCollapsed = replaceVisibleAgentIds.mock.calls.length;
    for (const call of replaceVisibleAgentIds.mock.calls) {
      expect(call[1]).toEqual([]);
    }

    click(header());
    expect(replaceVisibleAgentIds.mock.calls.length).toBeGreaterThan(callsWhileCollapsed);
    expect(replaceVisibleAgentIds).toHaveBeenLastCalledWith(expect.any(String), ["a"]);
  });
});
