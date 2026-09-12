import pLimit from "p-limit";
import type pino from "pino";
import webpush from "web-push";
import type { PushPayload } from "./push-service.js";
import type { VapidKeys } from "./vapid-keys.js";
import type { WebPushStore, StoredWebPushSubscription } from "./web-push-store.js";
import {
  HttpsWebPushTransport,
  WebPushDeliveryError,
  type WebPushTransport,
} from "./web-push-transport.js";
import { validatePushEndpoint, validateWebPushSubscription } from "./web-push-validation.js";
import type { WebPushSubscription } from "@getpaseo/protocol/messages";

export const VAPID_SUBJECT = "https://paseo.sh";
export const DEFAULT_WEB_PUSH_TTL_SECONDS = 86_400; // 24 hours
export const DEFAULT_MAX_PLAINTEXT_PAYLOAD_BYTES = 3072;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_CONCURRENCY = 5;

function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}

function truncateUtf8(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  if (end > 0) {
    const lead = buf[end - 1]!;
    let seqLen = 1;
    if ((lead & 0xe0) === 0xc0) seqLen = 2;
    else if ((lead & 0xf0) === 0xe0) seqLen = 3;
    else if ((lead & 0xf8) === 0xf0) seqLen = 4;
    if (seqLen > 1 && maxBytes - (end - 1) < seqLen) {
      end = end - 1;
    }
  }
  return buf.subarray(0, end).toString("utf8");
}

export function serializeAndBoundPayload(
  payload: PushPayload,
  maxBytes: number = DEFAULT_MAX_PLAINTEXT_PAYLOAD_BYTES,
): string {
  let body = payload.body || "";
  let obj: {
    title: string;
    body: string;
    data: Record<string, unknown>;
  } = {
    title: payload.title,
    body,
    data: payload.data ?? {},
  };

  let json = JSON.stringify(obj);
  let bytes = Buffer.byteLength(json, "utf8");

  while (bytes > maxBytes && body.length > 0) {
    const excess = bytes - maxBytes;
    const currentBodyBytes = Buffer.byteLength(body, "utf8");
    const targetBodyBytes = Math.max(0, currentBodyBytes - excess);
    body = truncateUtf8(body, targetBodyBytes);
    obj.body = body;
    json = JSON.stringify(obj);
    bytes = Buffer.byteLength(json, "utf8");
  }

  if (bytes > maxBytes) {
    obj = {
      title: truncateUtf8(payload.title, 100),
      body: "",
      data: {
        serverId: payload.data?.serverId,
        workspaceId: payload.data?.workspaceId,
        agentId: payload.data?.agentId,
        terminalId: payload.data?.terminalId,
      },
    };
    json = JSON.stringify(obj);
  }

  return json;
}

export interface WebPushServiceOptions {
  logger: pino.Logger;
  vapidKeys: VapidKeys;
  store: WebPushStore;
  transport?: WebPushTransport;
  ttlSeconds?: number;
  maxPayloadBytes?: number;
  requestTimeoutMs?: number;
  concurrency?: number;
}

/**
 * Service for sending Web Push notifications to browsers.
 *
 * Requirements:
 * - Per-send VAPID details (no global state).
 * - HTTPS subject https://paseo.sh.
 * - aes128gcm content encoding.
 * - Bounded payload length and timeout.
 * - Narrow injectable transport for tests.
 * - SSRF safe endpoint validation.
 * - Isolated network failure handling.
 * - 410/404 auto cleanup.
 */
export class WebPushService {
  private readonly logger: pino.Logger;
  private readonly vapidKeys: VapidKeys;
  private readonly store: WebPushStore;
  private readonly transport: WebPushTransport;
  private readonly ttlSeconds: number;
  private readonly maxPayloadBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly concurrency: number;

  constructor(options: WebPushServiceOptions) {
    this.logger = options.logger.child({ component: "web-push-service" });
    this.vapidKeys = options.vapidKeys;
    this.store = options.store;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.transport = options.transport ?? new HttpsWebPushTransport(this.requestTimeoutMs);
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_WEB_PUSH_TTL_SECONDS;
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PLAINTEXT_PAYLOAD_BYTES;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  }

  getPublicKey(): string {
    return this.vapidKeys.publicKey;
  }

  subscribe(subscription: WebPushSubscription, principalId: string, clientId?: string): void {
    const validated = validateWebPushSubscription(subscription);
    this.store.subscribe(
      { ...validated, deviceClass: subscription.deviceClass },
      principalId,
      clientId,
    );
  }

  unsubscribe(endpoint: string, principalId: string, clientId?: string): boolean {
    return this.store.unsubscribe(endpoint, principalId, clientId);
  }

  renewPrincipal(principalId: string, clientId?: string): void {
    this.store.renewPrincipal(principalId, clientId);
  }
  revokePrincipal(principalId: string): number {
    return this.store.revokePrincipal(principalId);
  }

  async test(endpoint: string, principalId: string): Promise<void> {
    const normalized = endpoint.trim();
    const subscription = this.store.getSubscription(normalized);
    if (!subscription) {
      throw new Error("Push subscription endpoint not found or expired");
    }

    if (subscription.principalId !== principalId) {
      throw new Error(
        "Push subscription endpoint is registered to another authenticated principal",
      );
    }

    const testPayload: PushPayload = {
      title: "Paseo",
      body: "Web push notifications are configured.",
      data: { test: true },
    };

    // Attempt delivery directly; if it fails, throw so the caller receives the delivery failure.
    await this.deliverToSubscription(subscription, testPayload);
  }

  async sendPush(payload: PushPayload, options?: { scope?: "all" | "mobile" }): Promise<void> {
    const subscriptions = this.store
      .getActiveSubscriptions()
      // "mobile" scope reaches mobile-class endpoints only; subscriptions
      // without a recorded class are treated as desktop.
      .filter((sub) => options?.scope !== "mobile" || sub.deviceClass === "mobile");
    if (subscriptions.length === 0) {
      return;
    }

    this.logger.info(
      { subscriberCount: subscriptions.length },
      "Broadcasting web push notification",
    );

    const limit = pLimit(this.concurrency);
    const tasks = subscriptions.map((sub) =>
      limit(async () => {
        const currentSub = this.store.getSubscription(sub.endpoint);
        if (!currentSub || currentSub.principalId !== sub.principalId) {
          return;
        }
        try {
          await this.deliverToSubscription(currentSub, payload);
        } catch (error) {
          // Network and delivery failures are kept isolated per subscription
          const err = error instanceof Error ? error : new Error(String(error));
          const statusCode = error instanceof WebPushDeliveryError ? error.statusCode : undefined;

          if (statusCode === 410 || statusCode === 404) {
            this.store.removeEndpoint(sub.endpoint);
          } else {
            this.logger.warn(
              {
                host: safeHost(sub.endpoint),
                principalId: sub.principalId,
                statusCode,
                err: err.message,
              },
              "Web push notification delivery failed for subscription",
            );
          }
        }
      }),
    );

    await Promise.allSettled(tasks);
  }

  /**
   * Whether a scope-scoped push would reach an active subscription owned by
   * this client. Used to suppress the page-local OS notification when the
   * service worker will already show one for the same event.
   */
  hasPushCoverageForClient(clientId: string, scope: "all" | "mobile"): boolean {
    const normalized = clientId.trim();
    return this.store
      .getActiveSubscriptions()
      .some(
        (sub) =>
          sub.clientId === normalized && (scope !== "mobile" || sub.deviceClass === "mobile"),
      );
  }

  private async deliverToSubscription(
    subscription: StoredWebPushSubscription,
    payload: PushPayload,
  ): Promise<void> {
    validatePushEndpoint(subscription.endpoint);

    const serializedPayload = serializeAndBoundPayload(payload, this.maxPayloadBytes);

    const requestDetails = webpush.generateRequestDetails(
      {
        endpoint: subscription.endpoint,
        keys: subscription.keys,
      },
      serializedPayload,
      {
        vapidDetails: {
          subject: VAPID_SUBJECT,
          publicKey: this.vapidKeys.publicKey,
          privateKey: this.vapidKeys.privateKey,
        },
        TTL: this.ttlSeconds,
        contentEncoding: "aes128gcm",
        timeout: this.requestTimeoutMs,
      },
    );

    await this.transport.send({
      endpoint: subscription.endpoint,
      method: requestDetails.method,
      headers: requestDetails.headers,
      body: requestDetails.body,
      timeoutMs: this.requestTimeoutMs,
    });

    this.logger.debug(
      {
        host: safeHost(subscription.endpoint),
        principalId: subscription.principalId,
      },
      "Delivered web push notification",
    );
  }
}
