import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { HostPerformanceSnapshot } from "@getpaseo/protocol/host-performance";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFetchQuery } from "@/data/query";
import { useAppVisible } from "@/hooks/use-app-visible";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { HostPerformanceView } from "./types";

export interface UseHostPerformanceOptions {
  visible?: boolean;
}

export function hostPerformanceQueryKey(serverId: string | null | undefined) {
  return ["hostPerformanceSnapshot", serverId ?? ""] as const;
}

export function useHostPerformance(
  serverId: string | null | undefined,
  options: UseHostPerformanceOptions = {},
): {
  view: HostPerformanceView;
  retry: () => Promise<void>;
  canFetch: boolean;
  isLive: boolean;
  isFetching: boolean;
} {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const isRetainedPanelActive = useRetainedPanelActive();
  const isAppVisible = useAppVisible();

  // COMPAT(hostPerformance): added in v0.8.0-beta.1, remove gate after 2027-03-10 once daemon floor >= v0.8.0.
  const supportsHostPerformance = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.hostPerformance === true,
  );

  const isLive = Boolean(
    (options.visible ?? true) &&
    isRetainedPanelActive &&
    isAppVisible &&
    isConnected &&
    supportsHostPerformance,
  );
  const canFetch = Boolean(serverId && client && isConnected && supportsHostPerformance);

  const queryKey = useMemo(() => hostPerformanceQueryKey(serverId), [serverId]);

  const queryFn = useCallback(async (): Promise<HostPerformanceSnapshot> => {
    if (!client) {
      throw new Error(t("hostPerformance.hostUnavailable"));
    }
    return client.getHostPerformanceSnapshot({ timeout: 8000 });
  }, [client, t]);

  const query = useFetchQuery<HostPerformanceSnapshot>({
    queryKey,
    queryFn,
    dataShape: "value",
    staleTimeMs: 2_500,
    enabled: Boolean(isLive && canFetch),
    retry: false,
    networkMode: "always",
    refetchInterval: isLive ? 2_500 : false,
  });

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, [isLive]);

  const retry = useCallback(async () => {
    if (!canFetch) return;
    await query.refetch();
  }, [canFetch, query]);

  const view = useMemo<HostPerformanceView>(() => {
    if (!serverId || !isConnected) {
      return {
        kind: "error",
        message: t("hostPerformance.hostUnavailable"),
        canRetry: false,
        isRetrying: false,
      };
    }
    if (!supportsHostPerformance) {
      return {
        kind: "unsupported",
        message: t("hostPerformance.hostUpgradeRequired"),
      };
    }
    if (query.isError) {
      return {
        kind: "error",
        message: query.error instanceof Error ? query.error.message : String(query.error),
        canRetry: true,
        isRetrying: query.isFetching,
      };
    }
    if (query.data) {
      const isStale = query.dataUpdatedAt > 0 && now - query.dataUpdatedAt > 10_000;
      return {
        kind: "ready",
        snapshot: query.data,
        isRefreshing: query.isFetching,
        isStale,
      };
    }
    return { kind: "loading" };
  }, [
    isConnected,
    now,
    query.data,
    query.dataUpdatedAt,
    query.error,
    query.isError,
    query.isFetching,
    serverId,
    supportsHostPerformance,
    t,
  ]);

  return { view, retry, canFetch, isLive, isFetching: query.isFetching };
}
