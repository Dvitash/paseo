import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Linking, Platform, Text, View } from "react-native";
import { validateDesktopUrl } from "../shared/rpc";
import {
  DESKTOP_IFRAME_ALLOW,
  DESKTOP_IFRAME_REFERRER_POLICY,
  DESKTOP_IFRAME_SANDBOX,
} from "./policy";

// This module typechecks without the DOM library. Declare only what this module uses.
declare const window: {
  open(url: string, target?: string, features?: string): unknown;
};

declare const document: {
  readonly visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

interface IntersectionObserverEntryLike {
  readonly isIntersecting: boolean;
}

declare class IntersectionObserver {
  constructor(callback: (entries: readonly IntersectionObserverEntryLike[]) => void);
  observe(target: unknown): void;
  disconnect(): void;
}

export async function openExternal(url: string): Promise<void> {
  const validation = validateDesktopUrl(url);
  if (!validation.ok) {
    throw new Error(validation.message);
  }
  if (Platform.OS === "web") {
    if (typeof window !== "undefined" && typeof window.open === "function") {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
  }
  await Linking.openURL(url);
}

export interface DesktopWebFrameProps {
  url: string;
  theme: PluginTheme;
  layout: {
    compact: boolean;
    platform: "ios" | "android" | "web";
  };
  onReload: () => void;
}

export function DesktopWebFrame({ url, theme, layout, onReload }: DesktopWebFrameProps) {
  if (Platform.OS !== "web") {
    return <NativeDesktopFallback url={url} theme={theme} layout={layout} />;
  }

  return <WebDesktopViewer url={url} theme={theme} onReload={onReload} />;
}

function NativeDesktopFallback({
  url,
  theme,
  layout,
}: {
  url: string;
  theme: PluginTheme;
  layout: { compact: boolean };
}) {
  const [error, setError] = useState<string | null>(null);

  const handleOpen = useCallback(async () => {
    setError(null);
    try {
      await openExternal(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [url]);

  const handleOpenPress = useCallback(() => {
    void handleOpen();
  }, [handleOpen]);

  const styles = useMemo(
    () => ({
      nativeContainer: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        padding: 24,
        gap: 12,
        backgroundColor: theme.colors.surface0,
      },
      nativeTitle: {
        fontWeight: "600" as const,
        textAlign: "center" as const,
        fontSize: layout.compact ? 16 : 18,
        color: theme.colors.foreground,
      },
      fallbackText: {
        fontSize: 12,
        textAlign: "center" as const,
        color: theme.colors.foregroundMuted,
      },
      errorText: {
        fontSize: 12,
        textAlign: "center" as const,
        color: theme.colors.statusDanger,
      },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.nativeContainer}>
      <Icon name="Monitor" size={32} color={theme.colors.foregroundMuted} />
      <Text style={styles.nativeTitle}>Remote Desktop</Text>
      <Text style={styles.fallbackText}>
        Interactive streaming is supported in Paseo web. Tap below to launch externally.
      </Text>
      <Button title="Open in browser" color={theme.colors.accent} onPress={handleOpenPress} />
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

function WebDesktopViewer({
  url,
  theme,
  onReload,
}: {
  url: string;
  theme: PluginTheme;
  onReload: () => void;
}) {
  const containerRef = useRef<View>(null);
  // Initial state is false to ensure hidden retained tabs never mount an iframe
  // and kick the active controller before positive visibility is observed.
  const [isIntersecting, setIsIntersecting] = useState(false);
  const [isDocumentVisible, setIsDocumentVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iframeRevision, setIframeRevision] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "web") return;

    let observer: IntersectionObserver | null = null;
    const element = containerRef.current;
    if (element && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        const first = entries[0];
        if (first) {
          setIsIntersecting(first.isIntersecting);
        }
      });
      observer.observe(element);
    }

    const updateVisibility = () => {
      if (typeof document !== "undefined") {
        setIsDocumentVisible(document.visibilityState !== "hidden");
      }
    };

    updateVisibility();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", updateVisibility);
    }

    return () => {
      observer?.disconnect();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", updateVisibility);
      }
    };
  }, []);

  const handleOpen = useCallback(async () => {
    setError(null);
    try {
      await openExternal(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [url]);

  const handleOpenPress = useCallback(() => {
    void handleOpen();
  }, [handleOpen]);

  const handleUserReload = useCallback(() => {
    // Explicit user reload increments iframeRevision to force iframe element remount
    // so injected proxy scripts and stream state reload cleanly, while routine status
    // refetches do not churn the iframe.
    setIframeRevision((rev) => rev + 1);
    onReload();
  }, [onReload]);

  const styles = useMemo(
    () => ({
      frameContainer: {
        flex: 1,
        width: "100%" as const,
        height: "100%" as const,
      },
      toolbar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderBottomWidth: 1,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
      },
      toolbarStatus: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
      },
      statusText: {
        fontSize: 13,
        fontWeight: "500" as const,
        color: theme.colors.foreground,
      },
      toolbarActions: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
      },
      errorBanner: {
        paddingHorizontal: 12,
        paddingVertical: 4,
        backgroundColor: theme.colors.surface1,
      },
      errorText: {
        fontSize: 12,
        textAlign: "center" as const,
        color: theme.colors.statusDanger,
      },
      iframeWrapper: {
        flex: 1,
        width: "100%" as const,
        height: "100%" as const,
      },
      pausedBox: {
        flex: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      footer: {
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderTopWidth: 1,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
      },
      fallbackText: {
        fontSize: 12,
        textAlign: "center" as const,
        color: theme.colors.foregroundMuted,
      },
    }),
    [theme],
  );

  const isVisible = isIntersecting && isDocumentVisible;

  return (
    <View ref={containerRef} style={styles.frameContainer}>
      <View style={styles.toolbar}>
        <View style={styles.toolbarStatus}>
          <Icon name="Monitor" size={14} color={theme.colors.foregroundMuted} />
          <Text style={styles.statusText}>Desktop</Text>
        </View>
        <View style={styles.toolbarActions}>
          <Button
            title="Open externally"
            color={theme.colors.foregroundMuted}
            onPress={handleOpenPress}
          />
          <Button title="Reload" color={theme.colors.foregroundMuted} onPress={handleUserReload} />
        </View>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.iframeWrapper}>
        {isVisible ? (
          <iframe
            key={iframeRevision}
            src={url}
            title="Worktree Desktop"
            allow={DESKTOP_IFRAME_ALLOW}
            allowFullScreen
            referrerPolicy={DESKTOP_IFRAME_REFERRER_POLICY}
            sandbox={DESKTOP_IFRAME_SANDBOX}
            style={iframeDomStyle}
          />
        ) : (
          <View style={styles.pausedBox}>
            <Text style={styles.fallbackText}>Viewer paused while tab is hidden</Text>
          </View>
        )}
      </View>

      <View style={styles.footer}>
        <Text style={styles.fallbackText}>
          If remote desktop does not display, use Open externally.
        </Text>
      </View>
    </View>
  );
}

const iframeDomStyle = {
  width: "100%",
  height: "100%",
  border: "none",
  display: "block",
};
