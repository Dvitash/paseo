import { describe, expect, it } from "vitest";
import type { ProviderUsage } from "./types";
import {
  resolveProviderUsageSlot,
  resolveSidebarHostServerId,
  resolveSidebarProviderUsageSlots,
  resolveSidebarUsageGeometry,
} from "./sidebar-usage-model";

describe("resolveProviderUsageSlot", () => {
  it("extracts and rounds remainingPct from the omp-rollup window", () => {
    const provider: ProviderUsage = {
      providerId: "openai-codex",
      displayName: "OpenAI Codex",
      status: "available",
      planLabel: null,
      windows: [
        {
          id: "omp-rollup",
          label: "Usage",
          usedPct: 73.8,
          remainingPct: 26.2,
        },
      ],
    };

    const slot = resolveProviderUsageSlot(provider);
    expect(slot).toEqual({
      providerId: "openai-codex",
      displayName: "OpenAI Codex",
      usedPct: 73.8,
      remainingPct: 26.2,
      status: "available",
      percentageText: "26%",
      accessibilityLabel: "OpenAI Codex: 26% remaining",
      tooltipText: "OpenAI Codex: 26% remaining",
    });
  });

  it("keeps cached percentages and identifies them in the tooltip", () => {
    const slot = resolveProviderUsageSlot({
      providerId: "opencode-go",
      displayName: "OpenCode Go",
      status: "available",
      planLabel: null,
      sourceLabel: "OMP (cached)",
      windows: [{ id: "omp-rollup", label: "Usage", usedPct: 74, remainingPct: 26 }],
    });
    expect(slot.percentageText).toBe("26%");
    expect(slot.tooltipText).toBe("OpenCode Go: 26% remaining · OMP (cached)");
  });

  it("handles 0% used correctly without treating it as unavailable", () => {
    const provider: ProviderUsage = {
      providerId: "openai-codex",
      displayName: "OpenAI Codex",
      status: "available",
      planLabel: null,
      windows: [
        {
          id: "omp-rollup",
          label: "Usage",
          usedPct: 0,
          remainingPct: 100,
        },
      ],
    };

    const slot = resolveProviderUsageSlot(provider);
    expect(slot.percentageText).toBe("100%");
    expect(slot.accessibilityLabel).toBe("OpenAI Codex: 100% remaining");
  });

  it("supports remaining-only windows when usedPct is absent", () => {
    const provider: ProviderUsage = {
      providerId: "anthropic",
      displayName: "Anthropic",
      status: "available",
      planLabel: null,
      windows: [{ id: "session", label: "Session", remainingPct: 42 }],
    };

    const slot = resolveProviderUsageSlot(provider);
    expect(slot.percentageText).toBe("42%");
    expect(slot.remainingPct).toBe(42);
    expect(slot.usedPct).toBe(58);
    expect(slot.accessibilityLabel).toBe("Anthropic: 42% remaining");
  });

  it("handles 0% remaining correctly without treating it as unavailable", () => {
    const provider: ProviderUsage = {
      providerId: "openai-codex",
      displayName: "OpenAI Codex",
      status: "available",
      planLabel: null,
      windows: [
        {
          id: "omp-rollup",
          label: "Usage",
          usedPct: 100,
          remainingPct: 0,
        },
      ],
    };

    const slot = resolveProviderUsageSlot(provider);
    expect(slot.percentageText).toBe("0%");
    expect(slot.remainingPct).toBe(0);
    expect(slot.accessibilityLabel).toBe("OpenAI Codex: 0% remaining");
  });

  it("falls back to the first window with a numeric percentage when omp-rollup is absent", () => {
    const provider: ProviderUsage = {
      providerId: "anthropic",
      displayName: "Anthropic",
      status: "available",
      planLabel: "Pro",
      windows: [
        { id: "five_hour", label: "5-Hour", usedPct: 50.1 },
        { id: "weekly", label: "Weekly", usedPct: 20 },
      ],
    };

    const slot = resolveProviderUsageSlot(provider);
    expect(slot.percentageText).toBe("50%");
    expect(slot.accessibilityLabel).toBe("Anthropic: 50% remaining");
  });

  it("returns an em dash when no limits or percentages are available", () => {
    const provider: ProviderUsage = {
      providerId: "custom",
      displayName: "Custom Provider",
      status: "available",
      planLabel: null,
      windows: [
        {
          id: "omp-rollup",
          label: "Usage",
          usedPct: null,
          remainingPct: null,
        },
      ],
    };

    const slot = resolveProviderUsageSlot(provider);
    expect(slot.percentageText).toBe("—");
    expect(slot.usedPct).toBeNull();
    expect(slot.accessibilityLabel).toBe("Custom Provider: usage unavailable");
  });

  it("does not display a retained percentage when the provider reports an error", () => {
    const provider: ProviderUsage = {
      providerId: "errored",
      displayName: "Errored Provider",
      status: "error",
      planLabel: null,
      windows: [{ id: "omp-rollup", label: "Usage", usedPct: 74 }],
      error: "Auth failure",
    };

    const slot = resolveProviderUsageSlot(provider);
    expect(slot.percentageText).toBe("—");
    expect(slot.usedPct).toBeNull();
    expect(slot.status).toBe("error");
  });
});

describe("resolveSidebarProviderUsageSlots", () => {
  it("maps an array of providers to slots", () => {
    const providers: ProviderUsage[] = [
      {
        providerId: "anthropic",
        displayName: "Anthropic",
        status: "available",
        planLabel: null,
        windows: [{ id: "omp-rollup", label: "Usage", usedPct: 50 }],
      },
      {
        providerId: "openai-codex",
        displayName: "Codex",
        status: "available",
        planLabel: null,
        windows: [{ id: "omp-rollup", label: "Usage", usedPct: 74 }],
      },
    ];

    const slots = resolveSidebarProviderUsageSlots(providers);
    expect(slots).toHaveLength(2);
    expect(slots[0]?.percentageText).toBe("50%");
    expect(slots[1]?.percentageText).toBe("26%");
  });
});

describe("resolveSidebarUsageGeometry", () => {
  it("fits the whole provider set in one row at ~300px, then wraps", () => {
    // 5 slots in 264px: 4 fit at the 60px minimum -> 2 rows (3/2).
    expect(resolveSidebarUsageGeometry({ slotCount: 5, availableWidth: 264 })).toEqual({
      density: "compact",
      iconSize: 14,
      slotsPerRow: 3,
      rowCount: 2,
      showsName: false,
    });
    // 5 slots in 300px: all five fit one row.
    expect(resolveSidebarUsageGeometry({ slotCount: 5, availableWidth: 300 })).toEqual({
      density: "compact",
      iconSize: 14,
      slotsPerRow: 5,
      rowCount: 1,
      showsName: false,
    });
    // 5 slots in 150px: 2 per row -> 3 rows (2/2/1).
    expect(resolveSidebarUsageGeometry({ slotCount: 5, availableWidth: 150 })).toEqual({
      density: "compact",
      iconSize: 14,
      slotsPerRow: 2,
      rowCount: 3,
      showsName: false,
    });
    // 5 slots in 50px: 1 per row -> 5 rows.
    expect(resolveSidebarUsageGeometry({ slotCount: 5, availableWidth: 50 })).toEqual({
      density: "tight",
      iconSize: 12,
      slotsPerRow: 1,
      rowCount: 5,
      showsName: false,
    });
  });

  it("shows the provider name when a slot is wide enough", () => {
    // 2 slots in 264px -> 132px slots, room for a name.
    expect(resolveSidebarUsageGeometry({ slotCount: 2, availableWidth: 264 })).toEqual({
      density: "spacious",
      iconSize: 14,
      slotsPerRow: 2,
      rowCount: 1,
      showsName: true,
    });
  });

  it("uses fallback width when availableWidth is not provided or zero", () => {
    expect(resolveSidebarUsageGeometry({ slotCount: 2 })).toEqual({
      density: "spacious",
      iconSize: 14,
      slotsPerRow: 2,
      rowCount: 1,
      showsName: true,
    });
    expect(resolveSidebarUsageGeometry({ slotCount: 5, availableWidth: 0 }).rowCount).toBe(2);
  });
});

describe("resolveSidebarHostServerId", () => {
  it("prioritizes single explicit host filter", () => {
    expect(
      resolveSidebarHostServerId({
        hostFilters: ["host-filter-1"],
        activeWorkspaceServerId: "workspace-host",
        lastWorkspaceServerId: "last-host",
        earliestOnlineHostServerId: "online-host",
        localDaemonServerId: "local-host",
        availableHostServerIds: ["host-filter-1", "workspace-host", "online-host"],
      }),
    ).toBe("host-filter-1");
  });

  it("prioritizes active workspace host when no single filter", () => {
    expect(
      resolveSidebarHostServerId({
        hostFilters: [],
        activeWorkspaceServerId: "workspace-host",
        lastWorkspaceServerId: "last-host",
        earliestOnlineHostServerId: "online-host",
        localDaemonServerId: "local-host",
        availableHostServerIds: ["workspace-host", "online-host"],
      }),
    ).toBe("workspace-host");
  });

  it("prefers the connected host over remembered workspace history", () => {
    expect(
      resolveSidebarHostServerId({
        hostFilters: [],
        activeWorkspaceServerId: null,
        lastWorkspaceServerId: "last-host",
        earliestOnlineHostServerId: "online-host",
        localDaemonServerId: "local-host",
        availableHostServerIds: ["last-host", "online-host", "local-host"],
      }),
    ).toBe("online-host");

    expect(
      resolveSidebarHostServerId({
        hostFilters: [],
        activeWorkspaceServerId: null,
        lastWorkspaceServerId: null,
        earliestOnlineHostServerId: "online-host",
        localDaemonServerId: "local-host",
        availableHostServerIds: ["online-host", "local-host"],
      }),
    ).toBe("online-host");

    expect(
      resolveSidebarHostServerId({
        hostFilters: [],
        activeWorkspaceServerId: null,
        lastWorkspaceServerId: null,
        earliestOnlineHostServerId: null,
        localDaemonServerId: "local-host",
        availableHostServerIds: ["local-host"],
      }),
    ).toBe("local-host");

    expect(
      resolveSidebarHostServerId({
        hostFilters: [],
        activeWorkspaceServerId: null,
        lastWorkspaceServerId: null,
        earliestOnlineHostServerId: null,
        localDaemonServerId: null,
        availableHostServerIds: ["avail-1"],
      }),
    ).toBe("avail-1");

    expect(
      resolveSidebarHostServerId({
        hostFilters: [],
        activeWorkspaceServerId: null,
        lastWorkspaceServerId: null,
        earliestOnlineHostServerId: null,
        localDaemonServerId: null,
        availableHostServerIds: [],
      }),
    ).toBeNull();
  });

  it("ignores stale filter and workspace IDs that are absent from the host picker", () => {
    expect(
      resolveSidebarHostServerId({
        hostFilters: ["removed-filter-host"],
        activeWorkspaceServerId: "removed-active-host",
        lastWorkspaceServerId: "removed-last-host",
        earliestOnlineHostServerId: "connected-host",
        localDaemonServerId: null,
        availableHostServerIds: ["connected-host"],
      }),
    ).toBe("connected-host");
  });
});
