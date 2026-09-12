import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isWeb } from "@/constants/platform";
import {
  getDesktopPermissionSnapshot,
  requestDesktopPermission,
  shouldShowDesktopPermissionSection,
  type DesktopPermissionKind,
  type DesktopPermissionSnapshot,
} from "@/desktop/permissions/desktop-permissions";
import { sendOsNotification } from "@/utils/os-notifications";
import { signalAgentAttentionAlert } from "@/utils/attention-alerts";

export interface UseDesktopPermissionsReturn {
  isDesktopApp: boolean;
  snapshot: DesktopPermissionSnapshot | null;
  isRefreshing: boolean;
  requestingPermission: DesktopPermissionKind | null;
  testNotificationState: TestNotificationState;
  refreshPermissions: () => Promise<void>;
  requestPermission: (kind: DesktopPermissionKind) => Promise<void>;
  sendTestNotification: () => Promise<void>;
}

export type TestNotificationState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "success" }
  | { status: "error"; message: string };

export function useDesktopPermissions(): UseDesktopPermissionsReturn {
  const { t } = useTranslation();
  const isDesktopApp = shouldShowDesktopPermissionSection();
  const isMountedRef = useRef(true);
  const [snapshot, setSnapshot] = useState<DesktopPermissionSnapshot | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [requestingPermission, setRequestingPermission] = useState<DesktopPermissionKind | null>(
    null,
  );
  const [testNotificationState, setTestNotificationState] = useState<TestNotificationState>({
    status: "idle",
  });

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const refreshPermissions = useCallback(async () => {
    if (!isWeb) {
      return;
    }

    setIsRefreshing(true);
    try {
      const nextSnapshot = await getDesktopPermissionSnapshot();
      if (!isMountedRef.current) {
        return;
      }
      setSnapshot(nextSnapshot);
    } catch (error) {
      console.error("[Settings] Failed to load desktop permission status", error);
    } finally {
      if (isMountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, []);

  const requestPermission = useCallback(
    async (kind: DesktopPermissionKind) => {
      if (!isWeb) {
        return;
      }

      setRequestingPermission(kind);
      try {
        const status = await requestDesktopPermission({ kind });
        if (!isMountedRef.current) {
          return;
        }

        setSnapshot((previous) => {
          const base: DesktopPermissionSnapshot = previous ?? {
            checkedAt: Date.now(),
            notifications: {
              state: "unknown",
              detail: t("desktop.permissions.empty.notifications"),
            },
            microphone: {
              state: "unknown",
              detail: t("desktop.permissions.empty.microphone"),
            },
          };

          if (kind === "notifications") {
            return {
              ...base,
              checkedAt: Date.now(),
              notifications: status,
            };
          }

          return {
            ...base,
            checkedAt: Date.now(),
            microphone: status,
          };
        });
      } catch (error) {
        console.error(`[Settings] Failed to request ${kind} permission`, error);
      } finally {
        if (isMountedRef.current) {
          setRequestingPermission(null);
        }
        await refreshPermissions();
      }
    },
    [refreshPermissions, t],
  );

  const sendTestNotification = useCallback(async () => {
    if (!isWeb) {
      return;
    }

    setTestNotificationState({ status: "sending" });
    try {
      const sent = await sendOsNotification({
        title: t("desktop.permissions.testNotification.title"),
        body: t("desktop.permissions.testNotification.body"),
      });
      // On web the OS notification is silent — exercise the in-app chime too.
      signalAgentAttentionAlert("finished");
      if (!isMountedRef.current) {
        return;
      }
      setTestNotificationState(
        sent
          ? { status: "success" }
          : {
              status: "error",
              message: t("desktop.permissions.testNotification.notDelivered"),
            },
      );
    } catch {
      if (isMountedRef.current) {
        setTestNotificationState({
          status: "error",
          message: t("desktop.permissions.testNotification.failed"),
        });
      }
    }
  }, [t]);

  useEffect(() => {
    if (!isWeb) {
      return;
    }

    void refreshPermissions();
  }, [refreshPermissions]);

  return {
    isDesktopApp,
    snapshot,
    isRefreshing,
    requestingPermission,
    testNotificationState,
    refreshPermissions,
    requestPermission,
    sendTestNotification,
  };
}
