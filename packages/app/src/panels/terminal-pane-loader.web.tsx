import { Suspense, lazy, type ComponentProps } from "react";
import { ActivityIndicator, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { TerminalPane } from "@/components/terminal-pane";

export type TerminalPaneLoaderProps = ComponentProps<typeof TerminalPane>;

const LazyTerminalPane = lazy(() =>
  import("@/components/terminal-pane").then((module) => ({ default: module.TerminalPane })),
);

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);

const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
});

function TerminalPaneLoadingFallback() {
  return (
    <View style={styles.loadingContainer} testID="terminal-panel-loading">
      <ThemedActivityIndicator size="small" uniProps={foregroundMutedColorMapping} />
    </View>
  );
}

const loadingFallback = <TerminalPaneLoadingFallback />;

export function TerminalPaneLoader(props: TerminalPaneLoaderProps) {
  return (
    <Suspense fallback={loadingFallback}>
      <LazyTerminalPane {...props} />
    </Suspense>
  );
}
