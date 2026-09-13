import { useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { HostTokenUsageSnapshot } from "@getpaseo/protocol/host-token-usage";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { TokenUsageView } from "./types";

export function tokenUsageQueryKey(serverId: string | null | undefined) {
  return ["hostTokenUsageSnapshot", serverId ?? ""] as const;
}

export function useTokenUsage(
  serverId: string | null | undefined,
  options: { enabled?: boolean } = {},
): {
  view: TokenUsageView;
  refresh: () => Promise<void>;
  isRefreshing: boolean;
} {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const [isRefreshing, setIsRefreshing] = useState(false);

  // COMPAT(hostTokenUsage): added in v0.8.0-beta.1, remove gate after 2027-03-13 once daemon floor >= v0.8.0.
  const supportsHostTokenUsage = useSessionStore(
    (state) => state.sessions[serverId ?? ""]?.serverInfo?.features?.hostTokenUsage === true,
  );

  const canFetch = Boolean(
    serverId && client && isConnected && supportsHostTokenUsage && (options.enabled ?? true),
  );
  const queryKey = useMemo(() => tokenUsageQueryKey(serverId), [serverId]);

  const queryFn = useCallback(async (): Promise<HostTokenUsageSnapshot> => {
    if (!client) {
      throw new Error(t("tokenUsage.unavailable"));
    }
    return client.getHostTokenUsageSnapshot({ timeout: 15_000 });
  }, [client, t]);

  const query = useFetchQuery<HostTokenUsageSnapshot>({
    queryKey,
    queryFn,
    dataShape: "value",
    staleTimeMs: 60_000,
    enabled: canFetch,
    retry: false,
    networkMode: "always",
  });

  const refresh = useCallback(async () => {
    if (!client || !canFetch || isRefreshing) return;
    setIsRefreshing(true);
    try {
      const freshSnapshot = await client.getHostTokenUsageSnapshot({
        timeout: 20_000,
        force: true,
      });
      queryClient.setQueryData(queryKey, freshSnapshot);
    } catch {
      await query.refetch();
    } finally {
      setIsRefreshing(false);
    }
  }, [client, canFetch, isRefreshing, queryClient, queryKey, query]);

  const view = useMemo<TokenUsageView>(() => {
    if (!serverId || !isConnected) {
      return {
        kind: "unavailable",
        message: t("tokenUsage.unavailable"),
      };
    }

    if (!supportsHostTokenUsage) {
      return {
        kind: "unavailable",
        message: t("tokenUsage.hostUpgradeRequired"),
      };
    }

    if (query.isPending && !query.data) {
      return { kind: "loading" };
    }

    if (query.isError && !query.data) {
      const message =
        query.error instanceof Error ? query.error.message : t("tokenUsage.errorTitle");
      return {
        kind: "error",
        message,
      };
    }

    const snapshot = query.data;
    if (!snapshot) {
      return { kind: "loading" };
    }

    if (snapshot.status === "unavailable" || !snapshot.ranges) {
      return {
        kind: "unavailable",
        message: snapshot.error ?? t("tokenUsage.unavailable"),
      };
    }

    return {
      kind: "ready",
      ranges: snapshot.ranges,
      fetchedAt: snapshot.fetchedAt,
      isRefreshing,
    };
  }, [
    serverId,
    isConnected,
    supportsHostTokenUsage,
    query.isPending,
    query.data,
    query.isError,
    query.error,
    isRefreshing,
    t,
  ]);

  return { view, refresh, isRefreshing };
}
