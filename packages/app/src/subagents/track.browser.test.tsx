import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import type { ViewedTimelineUiBridge } from "@/timeline/viewed-timeline-sync";
import { SubagentsTrack } from "./track";
import type { PaseoSubagentRow, SubagentRow } from "./select";

beforeEach(() => vi.stubGlobal("React", React));

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function mount(node: ReactNode): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return container;
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

function createRow(
  overrides: Partial<PaseoSubagentRow> & Pick<PaseoSubagentRow, "id">,
): PaseoSubagentRow {
  return {
    kind: "paseo",
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    title: overrides.title ?? `Agent ${overrides.id}`,
    description: null,
    subtitle: null,
    status: overrides.status ?? "running",
    turn:
      overrides.turn ??
      (overrides.status === "running"
        ? { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null }
        : { phase: "idle", cancellationRequestId: null }),
    requiresAttention: overrides.requiresAttention ?? false,
    createdAt: overrides.createdAt ?? new Date("2026-04-20T00:00:00.000Z"),
  };
}

describe("SubagentsTrack browser component tests", () => {
  beforeEach(async () => {
    if (!i18n.isInitialized) {
      await i18n.init();
    }
    await i18n.changeLanguage("en");
  });

  it("renders nothing when rows are empty and archive status is idle", () => {
    mount(
      <SubagentsTrack
        serverId="test-server"
        rows={[]}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    );

    const panel = document.querySelector('[data-testid="subagents-track-header-panel"]');
    expect(panel).toBeNull();
  });

  it("renders a single row with no overflow toggle", () => {
    const rows: SubagentRow[] = [createRow({ id: "agent-1", title: "Lone Worker" })];

    mount(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    );

    expect(document.querySelector('[data-testid="subagents-track-row-agent-1"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="subagents-track-overflow-toggle"]')).toBeNull();
  });

  it("renders exactly 5 rows with no overflow toggle when 5 rows exist", async () => {
    const rows: SubagentRow[] = Array.from({ length: 5 }, (_, i) =>
      createRow({
        id: `agent-${i + 1}`,
        title: `Worker ${i + 1}`,
        createdAt: new Date(2026, 3, 20, 0, i),
      }),
    );

    const container = mount(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    );
    container.style.width = "720px";

    for (let i = 1; i <= 5; i++) {
      expect(
        document.querySelector(`[data-testid="subagents-track-row-agent-${i}"]`),
      ).not.toBeNull();
    }
    expect(document.querySelector('[data-testid="subagents-track-overflow-toggle"]')).toBeNull();

    const card = document.querySelector('[data-testid="subagents-track-header-panel"]');
    expect(card).not.toBeNull();
    if (card instanceof HTMLElement) {
      expect(card.scrollHeight).toBeGreaterThan(150);
    }

    if (typeof page?.screenshot === "function") {
      await page.screenshot({ path: "test-results/subagents-track-5-rows.png" });
    }
  });

  it("renders 5 rows by default and toggles +1 more when 6 rows exist", () => {
    const rows: SubagentRow[] = Array.from({ length: 6 }, (_, i) =>
      createRow({
        id: `agent-${i + 1}`,
        title: `Worker ${i + 1}`,
        createdAt: new Date(2026, 3, 20, 0, i),
      }),
    );

    mount(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    );

    // First 5 visible, 6th not visible
    for (let i = 1; i <= 5; i++) {
      expect(
        document.querySelector(`[data-testid="subagents-track-row-agent-${i}"]`),
      ).not.toBeNull();
    }
    expect(document.querySelector('[data-testid="subagents-track-row-agent-6"]')).toBeNull();

    const toggle = document.querySelector('[data-testid="subagents-track-overflow-toggle"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain("+1 more");

    // Click to expand
    click(toggle as Element);
    expect(document.querySelector('[data-testid="subagents-track-row-agent-6"]')).not.toBeNull();
    expect(toggle?.textContent).toContain("Show less");

    // Click to collapse
    click(toggle as Element);
    expect(document.querySelector('[data-testid="subagents-track-row-agent-6"]')).toBeNull();
    expect(toggle?.textContent).toContain("+1 more");
  });

  it("expands inline details on row click and exposes separate Open conversation action", () => {
    const onOpen = vi.fn();
    const rows: SubagentRow[] = [createRow({ id: "agent-target", title: "Clickable Worker" })];

    mount(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={onOpen}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    );

    // Initially collapsed
    expect(
      document.querySelector('[data-testid="subagents-track-details-agent-target"]'),
    ).toBeNull();
    expect(document.querySelector('[data-testid="subagents-track-open-agent-target"]')).toBeNull();

    // Click row to expand inline details
    const rowEl = document.querySelector('[data-testid="subagents-track-row-agent-target"]');
    click(rowEl as Element);

    expect(
      document.querySelector('[data-testid="subagents-track-details-agent-target"]'),
    ).not.toBeNull();
    const openButton = document.querySelector('[data-testid="subagents-track-open-agent-target"]');
    expect(openButton).not.toBeNull();

    // Click Open conversation button
    click(openButton as Element);
    expect(onOpen).toHaveBeenCalledWith("agent-target");

    // Click row again to collapse
    click(rowEl as Element);
    expect(
      document.querySelector('[data-testid="subagents-track-details-agent-target"]'),
    ).toBeNull();
  });

  it("hides completed subagents entirely, showing only active rows", () => {
    const rows: SubagentRow[] = [
      createRow({ id: "active-1", title: "Active Worker", status: "running" }),
      createRow({ id: "comp-1", title: "Done Worker", status: "idle" }),
      createRow({ id: "comp-2", title: "Second Done", status: "idle" }),
    ];

    mount(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    );

    // Active row is visible directly
    expect(document.querySelector('[data-testid="subagents-track-row-active-1"]')).not.toBeNull();

    // Completed rows are hidden entirely, with no summary to expand
    expect(document.querySelector('[data-testid="subagents-track-row-comp-1"]')).toBeNull();
    expect(document.querySelector('[data-testid="subagents-track-row-comp-2"]')).toBeNull();
    expect(document.querySelector('[data-testid="subagents-track-completed-summary"]')).toBeNull();
  });

  it("hides failed subagents and keeps attention rows visible", () => {
    const rows: SubagentRow[] = [
      createRow({ id: "failed-1", title: "Failed Worker", status: "error" }),
      createRow({
        id: "att-1",
        title: "Attention Worker",
        status: "idle",
        requiresAttention: true,
      }),
      createRow({ id: "done-1", title: "Done Worker", status: "idle" }),
    ];

    mount(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    );

    // Failed and completed rows are hidden entirely; attention rows stay visible
    expect(document.querySelector('[data-testid="subagents-track-row-failed-1"]')).toBeNull();
    expect(document.querySelector('[data-testid="subagents-track-row-done-1"]')).toBeNull();
    expect(document.querySelector('[data-testid="subagents-track-row-att-1"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="subagents-track-completed-summary"]')).toBeNull();
  });

  it("renders bulk archive finished action when finished subagents exist", () => {
    const onArchiveFinished = vi.fn();
    const rows: SubagentRow[] = [createRow({ id: "done-1", title: "Done Worker", status: "idle" })];

    mount(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
        onArchiveFinished={onArchiveFinished}
      />,
    );

    const archiveBtn = document.querySelector('[data-testid="subagents-track-archive-finished"]');
    expect(archiveBtn).not.toBeNull();

    click(archiveBtn as Element);
    expect(onArchiveFinished).toHaveBeenCalledTimes(1);
  });

  it("registers displayed managed child IDs with viewedTimelineSync and cleans up on unmount", () => {
    const bridgeCalls: Array<{ sourceId: string; agentIds: string[] }> = [];
    const bridgeStub: ViewedTimelineUiBridge = {
      replaceVisibleAgentIds(sourceId, agentIds) {
        bridgeCalls.push({ sourceId, agentIds });
      },
      subscribe: () => () => {},
      getAgentTimelineStatus: () => "ready",
      getAgentTimelineError: () => null,
      retryVisibleAgentTimeline: vi.fn(),
    };

    useSessionStore.getState().initializeSession("test-server", null as unknown as never);
    useSessionStore.getState().setViewedTimelineSync("test-server", bridgeStub);

    const rows: SubagentRow[] = [
      createRow({ id: "managed-1", title: "Managed 1" }),
      createRow({ id: "managed-2", title: "Managed 2" }),
    ];

    mount(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    );

    expect(bridgeCalls.length).toBeGreaterThan(0);
    const lastRegistration = bridgeCalls[bridgeCalls.length - 1];
    expect(lastRegistration.agentIds).toEqual(["managed-1", "managed-2"]);

    // Unmount and verify cleanup with []
    const lastMounted = mounted.pop();
    if (lastMounted) {
      act(() => lastMounted.root.unmount());
      lastMounted.container.remove();
    }

    const finalCall = bridgeCalls[bridgeCalls.length - 1];
    expect(finalCall.agentIds).toEqual([]);
  });

  it("includes agentStreamHead in summaries so latest head items are displayed", () => {
    useSessionStore.getState().initializeSession("test-server", null as unknown as never);

    const initialTail: StreamItem[] = [
      {
        kind: "assistant_message",
        id: "a1",
        text: "Tail assistant message",
        timestamp: new Date(),
      },
    ];
    useSessionStore.getState().setAgentStreamState("test-server", "agent-head-test", {
      tail: initialTail,
    });

    const rows: SubagentRow[] = [
      createRow({ id: "agent-head-test", title: "Head Test Agent", status: "running" }),
    ];

    mount(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    );

    const rowEl = document.querySelector('[data-testid="subagents-track-row-agent-head-test"]');
    expect(rowEl).not.toBeNull();

    // Now update agentStreamHead with a new tool call
    act(() => {
      useSessionStore.getState().setAgentStreamState("test-server", "agent-head-test", {
        head: [
          {
            kind: "tool_call",
            id: "t-head-1",
            timestamp: new Date(),
            payload: {
              source: "agent",
              data: {
                provider: "mock",
                callId: "call_head_1",
                name: "Reading head live item",
                status: "running",
                error: null,
                detail: { type: "shell", command: "test" },
              },
            },
          },
        ],
      });
    });

    expect(rowEl?.textContent).toContain("Reading head live item");
  });

  it("renders real tool call activity and updates reactively on store changes", () => {
    const initialTail: StreamItem[] = [
      {
        kind: "tool_call",
        id: "t1",
        timestamp: new Date(),
        payload: {
          source: "agent",
          data: {
            provider: "mock",
            callId: "call_1",
            name: "Bash `git status`",
            status: "running",
            error: null,
            detail: { type: "shell", command: "git status" },
          },
        },
      },
      {
        kind: "assistant_message",
        id: "a1",
        text: "Checked git status and everything looks clean.",
        timestamp: new Date(),
      },
    ];

    useSessionStore.getState().initializeSession("test-server", null as unknown as never);
    useSessionStore.getState().setAgentStreamState("test-server", "agent-active", {
      tail: initialTail,
    });

    const rows: SubagentRow[] = [
      createRow({ id: "agent-active", title: "Git Agent", status: "running" }),
    ];

    mount(
      <SubagentsTrack
        serverId="test-server"
        rows={rows}
        onOpenSubagent={vi.fn()}
        onOpenProviderSubagent={vi.fn()}
        onArchiveSubagent={vi.fn()}
      />,
    );

    const rowEl = document.querySelector('[data-testid="subagents-track-row-agent-active"]');
    expect(rowEl).not.toBeNull();
    expect(rowEl?.textContent).toContain("Bash `git status`");

    // Expand details to verify bounded recent actions and latest assistant message
    click(rowEl as Element);
    const details = document.querySelector('[data-testid="subagents-track-details-agent-active"]');
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain("Bash `git status`");
    expect(details?.textContent).toContain("Checked git status and everything looks clean.");

    // Update stream in store to verify reactive activity updates
    act(() => {
      useSessionStore.getState().setAgentStreamState("test-server", "agent-active", {
        tail: [
          ...initialTail,
          {
            kind: "tool_call",
            id: "t2",
            timestamp: new Date(),
            payload: {
              source: "agent",
              data: {
                provider: "mock",
                callId: "call_2",
                name: "Edit `src/subagents/track.tsx`",
                status: "running",
                error: null,
                detail: { type: "shell", command: "edit" },
              },
            },
          },
        ],
      });
    });

    expect(rowEl?.textContent).toContain("Edit `src/subagents/track.tsx`");
  });
});
