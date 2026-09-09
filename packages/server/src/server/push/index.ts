import type pino from "pino";

import { PushService, type PushPayload } from "./push-service.js";
import { PushTokenStore } from "./token-store.js";
import type { WebPushService } from "./web-push-service.js";

export type { PushPayload };

const PUSH_TOKEN_LEASE_MS = 48 * 60 * 60 * 1000;

export interface PushNotifications {
  renew(token: string): void;
  revoke(token: string): void;
  send(payload: PushPayload): Promise<void>;
  readonly webPush?: WebPushService;
}

export type PushNotificationSender = Pick<PushNotifications, "send">;

export function createPushNotifications(options: {
  logger: pino.Logger;
  filePath: string;
  now?: () => number;
  deliver?: (tokens: string[], payload: PushPayload) => Promise<void>;
  webPush?: WebPushService;
}): PushNotifications {
  const now = options.now ?? Date.now;
  const store = new PushTokenStore(options.logger, options.filePath, now, PUSH_TOKEN_LEASE_MS);
  const service = new PushService(options.logger, (token) => store.revokeToken(token));
  const deliver =
    options.deliver ??
    ((tokens: string[], payload: PushPayload) => service.sendPush(tokens, payload));

  return {
    webPush: options.webPush,
    renew(token) {
      store.renewToken(token);
    },
    revoke(token) {
      store.revokeToken(token);
    },
    async send(payload) {
      const expoTask = (async () => {
        const tokens = store.getActiveTokens();
        if (tokens.length > 0) {
          options.logger.info({ tokenCount: tokens.length }, "Sending push notification");
          await deliver(tokens, payload);
        }
      })();

      const webTask = (async () => {
        if (options.webPush) {
          await options.webPush.sendPush(payload);
        }
      })();

      await Promise.allSettled([expoTask, webTask]);
    },
  };
}
