import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";
import type {
  WebPushBrowserAdapter,
  WebPushConfig,
  WebPushDaemonClient,
  WebPushEnvironmentStatus,
  WebPushHostStatus,
  WebPushStorage,
  WebPushSubscription,
} from "./internal/web-push-types";

export function startPushNotifications(_input: StartPushNotificationsInput): () => void {
  return () => undefined;
}

export async function revokePushNotifications(_input: RevokePushNotificationsInput): Promise<void> {
  // Default push notifications fallback.
}

export type {
  RevokePushNotificationsInput,
  StartPushNotificationsInput,
  WebPushBrowserAdapter,
  WebPushConfig,
  WebPushDaemonClient,
  WebPushEnvironmentStatus,
  WebPushHostStatus,
  WebPushStorage,
  WebPushSubscription,
};
