import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getDeviceClass, getIsElectron, isWeb, isNative } from "@/constants/platform";
import { getIsAppActivelyVisible } from "@/utils/app-visibility";
import { readDesktopSystemIdleTimeMs } from "@/desktop/electron/idle";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { subscribeNativeUserActivity } from "./native-activity-source";
import {
  type ClientActivityTracker,
  createClientActivityTracker,
  DESKTOP_IDLE_POLL_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
} from "./client-activity-tracker";

interface ClientActivityOptions {
  client: DaemonClient;
  focusedAgentId: string | null;
  focusedTerminalId: string | null;
}

/**
 * Handles client activity reporting:
 * - Heartbeat sending every 15 seconds
 * - App visibility tracking
 * - Records lastActivityAt only on real user activity (not on heartbeat)
 */
export function useClientActivity({
  client,
  focusedAgentId,
  focusedTerminalId,
}: ClientActivityOptions): void {
  const trackerRef = useRef<ClientActivityTracker | null>(null);
  if (!trackerRef.current) {
    trackerRef.current = createClientActivityTracker({
      client,
      deviceType: isWeb ? "web" : "mobile",
      deviceClass: getDeviceClass(),
      initialFocusedAgentId: focusedAgentId,
      initialFocusedTerminalId: focusedTerminalId,
      initialAppVisible: getIsAppActivelyVisible(),
      now: () => Date.now(),
    });
  }
  const tracker = trackerRef.current;

  // Track app visibility via AppState (native).
  useEffect(() => {
    const subscription = AppState.addEventListener("change", () => {
      tracker.notifyAppVisibility(getIsAppActivelyVisible());
      tracker.sendHeartbeat();
    });
    return () => subscription.remove();
  }, [tracker]);

  // Feed native touch activity into the tracker — without it an actively used
  // mobile client looks absent after PRESENCE_THRESHOLD_MS.
  useEffect(() => {
    if (!isNative) return;
    return subscribeNativeUserActivity(() => {
      tracker.recordUserActivity();
      tracker.maybeSendImmediateHeartbeat();
    });
  }, [tracker]);

  // Track user activity and visibility on web.
  useEffect(() => {
    if (isNative) return;
    if (typeof document === "undefined") return;

    const handleUserActivity = () => {
      tracker.recordUserActivity();
      tracker.maybeSendImmediateHeartbeat();
    };

    const syncVisibility = () => {
      tracker.notifyAppVisibility(getIsAppActivelyVisible());
      // Unthrottled on every transition: a hidden/blurred window must stop
      // suppressing mobile push immediately, not after the next interval.
      tracker.sendHeartbeat();
    };

    const handleFocus = () => {
      handleUserActivity();
      syncVisibility();
    };

    document.addEventListener("visibilitychange", syncVisibility);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", syncVisibility);
    window.addEventListener("pointerdown", handleUserActivity, { passive: true });
    window.addEventListener("keydown", handleUserActivity);
    window.addEventListener("wheel", handleUserActivity, { passive: true });
    window.addEventListener("touchstart", handleUserActivity, { passive: true });

    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", syncVisibility);
      window.removeEventListener("pointerdown", handleUserActivity);
      window.removeEventListener("keydown", handleUserActivity);
      window.removeEventListener("wheel", handleUserActivity);
      window.removeEventListener("touchstart", handleUserActivity);
    };
  }, [tracker]);

  // Track OS-wide activity in Electron so backgrounded desktop windows still report presence.
  useEffect(() => {
    if (!getIsElectron()) return;

    let disposed = false;
    const pollSystemIdleTime = async () => {
      const systemIdleMs = await readDesktopSystemIdleTimeMs(invokeDesktopCommand);
      if (disposed) return;
      tracker.notifySystemIdleMs(systemIdleMs);
    };

    const interval = setInterval(() => {
      void pollSystemIdleTime();
    }, DESKTOP_IDLE_POLL_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [tracker]);

  // Send heartbeat on focused agent change.
  useEffect(() => {
    tracker.setFocusedAgentId(focusedAgentId);
  }, [focusedAgentId, tracker]);

  // Send heartbeat on focused terminal change.
  useEffect(() => {
    tracker.setFocusedTerminalId(focusedTerminalId);
  }, [focusedTerminalId, tracker]);

  // Periodic heartbeat gated by connection status.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId) clearInterval(intervalId);
      tracker.sendHeartbeat();
      intervalId = setInterval(() => tracker.sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    };

    const stop = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const unsubscribe = client.subscribeConnectionStatus((state) => {
      if (state.status === "connected") {
        start();
      } else {
        stop();
      }
    });

    return () => {
      unsubscribe();
      stop();
    };
  }, [client, tracker]);
}
