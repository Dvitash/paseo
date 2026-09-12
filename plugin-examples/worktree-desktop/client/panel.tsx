import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { Button, Text, View } from "react-native";
import { desktopStatusRpc, validateDesktopUrl } from "../shared/rpc";
import { DesktopWebFrame } from "./web";

export function DesktopPanel({ workspaceId, theme, layout }: PluginWorkspacePanelProps) {
  const callDesktopStatus = useRpc(desktopStatusRpc);

  const query = useQuery({
    queryKey: ["desktop.status", workspaceId],
    queryFn: () => callDesktopStatus({ workspaceId }),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (data?.status === "starting") {
        return 1000;
      }
      return false;
    },
  });

  const handleRefresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        backgroundColor: theme.colors.surface0,
      },
      centerContainer: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        gap: 12,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
      },
      title: {
        fontWeight: "600" as const,
        textAlign: "center" as const,
        fontSize: layout.compact ? 16 : 18,
        color: theme.colors.foreground,
      },
      message: {
        fontSize: 14,
        textAlign: "center" as const,
        maxWidth: 420,
        lineHeight: 20,
        color: theme.colors.foregroundMuted,
      },
      errorText: {
        fontSize: 14,
        textAlign: "center" as const,
        maxWidth: 420,
        lineHeight: 20,
        color: theme.colors.statusDanger,
      },
    }),
    [theme, layout.compact],
  );

  if (query.isLoading || query.isPending) {
    return (
      <View style={styles.centerContainer}>
        <Icon name="Monitor" size={32} color={theme.colors.foregroundMuted} />
        <Text style={styles.title}>Connecting to desktop…</Text>
        <Text style={styles.message}>Checking workspace desktop status</Text>
      </View>
    );
  }

  if (query.isError) {
    const errorMessage = query.error instanceof Error ? query.error.message : String(query.error);
    return (
      <View style={styles.centerContainer}>
        <Icon name="AlertCircle" size={32} color={theme.colors.statusDanger} />
        <Text style={styles.title}>Failed to load desktop</Text>
        <Text style={styles.errorText}>{errorMessage}</Text>
        <Button
          title={query.isFetching ? "Checking…" : "Retry"}
          disabled={query.isFetching}
          color={theme.colors.accent}
          onPress={handleRefresh}
        />
      </View>
    );
  }

  const status = query.data;

  if (status.status === "starting") {
    return (
      <View style={styles.centerContainer}>
        <Icon name="Monitor" size={32} color={theme.colors.accent} />
        <Text style={styles.title}>Starting desktop environment…</Text>
        <Text style={styles.message}>
          The desktop service is launching. This screen will update automatically once ready.
        </Text>
        <Button
          title={query.isFetching ? "Checking…" : "Refresh"}
          disabled={query.isFetching}
          color={theme.colors.accent}
          onPress={handleRefresh}
        />
      </View>
    );
  }

  if (status.status === "unavailable") {
    return (
      <View style={styles.centerContainer}>
        <Icon name="Monitor" size={32} color={theme.colors.foregroundMuted} />
        <Text style={styles.title}>Desktop unavailable</Text>
        <Text style={styles.message}>{status.message}</Text>
        <Button
          title={query.isFetching ? "Checking…" : "Retry"}
          disabled={query.isFetching}
          color={theme.colors.accent}
          onPress={handleRefresh}
        />
      </View>
    );
  }

  if (status.status === "error") {
    return (
      <View style={styles.centerContainer}>
        <Icon name="AlertCircle" size={32} color={theme.colors.statusDanger} />
        <Text style={styles.title}>Desktop startup error</Text>
        <Text style={styles.errorText}>{status.message}</Text>
        <Button
          title={query.isFetching ? "Checking…" : "Retry"}
          disabled={query.isFetching}
          color={theme.colors.accent}
          onPress={handleRefresh}
        />
      </View>
    );
  }

  const validation = validateDesktopUrl(status.url);
  if (!validation.ok) {
    return (
      <View style={styles.centerContainer}>
        <Icon name="AlertCircle" size={32} color={theme.colors.statusDanger} />
        <Text style={styles.title}>Invalid desktop URL</Text>
        <Text style={styles.errorText}>{validation.message}</Text>
        <Button
          title={query.isFetching ? "Checking…" : "Retry"}
          disabled={query.isFetching}
          color={theme.colors.accent}
          onPress={handleRefresh}
        />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <DesktopWebFrame url={status.url} theme={theme} layout={layout} onReload={handleRefresh} />
    </View>
  );
}
