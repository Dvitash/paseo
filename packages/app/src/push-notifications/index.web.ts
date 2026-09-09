import { getIsElectron } from "@/constants/platform";
import type { RevokePushNotificationsInput, StartPushNotificationsInput } from "./internal/types";
import { getWebPushManager, WebPushManager } from "./internal/web-push-manager";
import type {
  WebPushBrowserAdapter,
  WebPushConfig,
  WebPushDaemonClient,
  WebPushEnvironmentStatus,
  WebPushHostStatus,
  WebPushStorage,
  WebPushSubscription,
} from "./internal/web-push-types";

export function startPushNotifications(input: StartPushNotificationsInput): () => void {
  if (getIsElectron()) {
    return () => undefined;
  }

  return getWebPushManager().startSubscription({
    client: input.client,
    serverId: input.serverId,
  });
}

export async function revokePushNotifications(input: RevokePushNotificationsInput): Promise<void> {
  if (getIsElectron()) {
    return;
  }

  await getWebPushManager().revokeOnHostRemoval(input.serverId, input.client);
}

export { getWebPushManager, WebPushManager };
export type {
  WebPushBrowserAdapter,
  WebPushConfig,
  WebPushDaemonClient,
  WebPushEnvironmentStatus,
  WebPushHostStatus,
  WebPushStorage,
  WebPushSubscription,
};
