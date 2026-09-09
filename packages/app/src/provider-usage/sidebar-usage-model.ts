import { clampPct } from "./format";
import type { ProviderUsage, ProviderUsageStatus } from "./types";

export interface SidebarProviderUsageSlot {
  providerId: string;
  displayName: string;
  usedPct: number | null;
  remainingPct: number | null;
  status: ProviderUsageStatus;
  percentageText: string;
  accessibilityLabel: string;
  tooltipText: string;
}

export type SidebarUsageDensity = "spacious" | "compact" | "tight";

export interface SidebarUsageGeometry {
  density: SidebarUsageDensity;
  iconSize: number;
}

export function resolveSidebarUsageGeometry(input: {
  slotCount: number;
  availableWidth?: number | null;
}): SidebarUsageGeometry {
  const count = Math.max(1, input.slotCount);
  const width =
    typeof input.availableWidth === "number" && input.availableWidth > 0
      ? input.availableWidth
      : 264;
  const slotWidth = width / count;

  if (slotWidth >= 90) {
    return { density: "spacious", iconSize: 14 };
  }
  if (slotWidth >= 55) {
    return { density: "compact", iconSize: 14 };
  }
  return { density: "tight", iconSize: 12 };
}

export function resolveSidebarHostServerId(input: {
  hostFilters: readonly string[];
  activeWorkspaceServerId: string | null | undefined;
  lastWorkspaceServerId: string | null | undefined;
  earliestOnlineHostServerId: string | null | undefined;
  localDaemonServerId: string | null | undefined;
  availableHostServerIds: readonly string[];
}): string | null {
  const filteredHost = input.hostFilters.length === 1 ? input.hostFilters[0] : null;
  const candidates = [
    filteredHost,
    input.activeWorkspaceServerId,
    input.earliestOnlineHostServerId,
    input.lastWorkspaceServerId,
    input.localDaemonServerId,
    ...input.availableHostServerIds,
  ];
  return (
    candidates.find(
      (serverId): serverId is string =>
        typeof serverId === "string" && input.availableHostServerIds.includes(serverId),
    ) ?? null
  );
}

export function resolveProviderUsageSlot(provider: ProviderUsage): SidebarProviderUsageSlot {
  const window =
    provider.windows.find((candidate) => candidate.id === "omp-rollup") ??
    provider.windows.find(
      (candidate) =>
        (typeof candidate.remainingPct === "number" && Number.isFinite(candidate.remainingPct)) ||
        (typeof candidate.usedPct === "number" && Number.isFinite(candidate.usedPct)),
    ) ??
    null;

  const rawRemaining =
    window && typeof window.remainingPct === "number" && Number.isFinite(window.remainingPct)
      ? window.remainingPct
      : null;
  const rawUsed =
    window && typeof window.usedPct === "number" && Number.isFinite(window.usedPct)
      ? window.usedPct
      : null;

  const remainingPct = rawRemaining ?? (rawUsed !== null ? 100 - rawUsed : null);

  const usedPct = rawUsed ?? (rawRemaining !== null ? 100 - rawRemaining : null);

  const hasCurrentUsage = provider.status === "available" && remainingPct !== null;
  if (hasCurrentUsage) {
    const roundedRemaining = Math.round(clampPct(remainingPct));
    const percentageText = `${roundedRemaining}%`;
    const label = `${provider.displayName}: ${roundedRemaining}% remaining`;
    return {
      providerId: provider.providerId,
      displayName: provider.displayName,
      usedPct,
      remainingPct,
      status: provider.status,
      percentageText,
      accessibilityLabel: label,
      tooltipText: provider.sourceLabel ? `${label} · ${provider.sourceLabel}` : label,
    };
  }

  return {
    providerId: provider.providerId,
    displayName: provider.displayName,
    usedPct: null,
    remainingPct: null,
    status: provider.status,
    percentageText: "—",
    accessibilityLabel: `${provider.displayName}: usage unavailable`,
    tooltipText: `${provider.displayName}: usage unavailable`,
  };
}

export function resolveSidebarProviderUsageSlots(
  providers: readonly ProviderUsage[],
): SidebarProviderUsageSlot[] {
  return providers.map(resolveProviderUsageSlot);
}
