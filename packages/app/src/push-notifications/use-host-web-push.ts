import { useCallback, useEffect, useState } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { getWebPushManager } from "./internal/web-push-manager";
import type { WebPushHostStatus } from "./internal/web-push-types";

export interface UseHostWebPushResult {
  status: WebPushHostStatus;
  isSupported: boolean;
  isEnabling: boolean;
  isDisabling: boolean;
  isTesting: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  sendTestNotification: () => Promise<void>;
  clearError: () => void;
}

export function useHostWebPush(serverId: string): UseHostWebPushResult {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const manager = getWebPushManager();

  const [status, setStatus] = useState<WebPushHostStatus>(() => {
    return manager.getCachedStatus(serverId) ?? { kind: "disabled" };
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = manager.subscribeStatus(serverId, (nextStatus) => {
      setStatus(nextStatus);
      if (nextStatus.kind === "disabled" && nextStatus.error) {
        setError(nextStatus.error.message);
      } else if (nextStatus.kind === "enabled" && nextStatus.error) {
        setError(nextStatus.error.message);
      }
    });

    void manager.getStatus(serverId, client);

    return unsubscribe;
  }, [client, isConnected, manager, serverId]);

  const enable = useCallback(async () => {
    setError(null);
    if (!client) {
      setError("Host client not available");
      return;
    }

    const permPromise = manager.adapter.requestPermission();
    try {
      await manager.enable(serverId, client, permPromise);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to enable notifications";
      setError(msg);
    }
  }, [client, manager, serverId]);

  const disable = useCallback(async () => {
    setError(null);
    try {
      await manager.disable(serverId, client);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to disable notifications";
      setError(msg);
    }
  }, [client, manager, serverId]);

  const sendTestNotification = useCallback(async () => {
    setError(null);
    if (!client) {
      setError("Host client not available");
      return;
    }
    try {
      await manager.testNotification(serverId, client);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send test notification";
      setError(msg);
    }
  }, [client, manager, serverId]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const isSupported =
    status.kind !== "unsupported-browser" &&
    status.kind !== "unsupported-insecure" &&
    status.kind !== "unsupported-ios-homescreen";

  return {
    status,
    isSupported,
    isEnabling: status.kind === "enabling",
    isDisabling: status.kind === "enabled" && status.operation === "disabling",
    isTesting: status.kind === "enabled" && status.operation === "testing",
    error,
    enable,
    disable,
    sendTestNotification,
    clearError,
  };
}
