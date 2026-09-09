import { Suspense, lazy, type ComponentProps } from "react";
import { ActivityIndicator, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { FilePane } from "@/file-pane/pane";

export type FilePaneLoaderProps = ComponentProps<typeof FilePane>;

const LazyFilePane = lazy(() =>
  import("@/file-pane/pane").then((module) => ({ default: module.FilePane })),
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

function FilePaneLoadingFallback() {
  return (
    <View style={styles.loadingContainer} testID="file-panel-loading">
      <ThemedActivityIndicator size="small" uniProps={foregroundMutedColorMapping} />
    </View>
  );
}

const loadingFallback = <FilePaneLoadingFallback />;

export function FilePaneLoader(props: FilePaneLoaderProps) {
  return (
    <Suspense fallback={loadingFallback}>
      <LazyFilePane {...props} />
    </Suspense>
  );
}
