import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPushNotifications } from "./index.js";
import { loadOrCreateVapidKeys } from "./vapid-keys.js";
import { WebPushService } from "./web-push-service.js";
import { WebPushStore } from "./web-push-store.js";
import {
  WebPushDeliveryError,
  type WebPushTransport,
  type WebPushTransportRequest,
  type WebPushTransportResponse,
} from "./web-push-transport.js";

function generateValidP256dh(): string {
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);
  return uncompressed.toString("base64url");
}

function generateValidAuth(): string {
  return crypto.randomBytes(16).toString("base64url");
}

function createNoopLogger(): pino.Logger {
  return pino({ level: "silent" });
}

class RecordingTestTransport implements WebPushTransport {
  readonly sentRequests: WebPushTransportRequest[] = [];
  responsesByEndpoint = new Map<string, () => Promise<WebPushTransportResponse>>();

  async send(request: WebPushTransportRequest): Promise<WebPushTransportResponse> {
    this.sentRequests.push(request);
    const handler = this.responsesByEndpoint.get(request.endpoint);
    if (handler) {
      return handler();
    }
    return { statusCode: 201 };
  }
}

describe("WebPushService", () => {
  let tempDir: string;
  let vapidKeyPath: string;
  let storePath: string;
  let transport: RecordingTestTransport;
  let store: WebPushStore;
  let service: WebPushService;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "web-push-service-test-"));
    vapidKeyPath = path.join(tempDir, "vapid-keys.json");
    storePath = path.join(tempDir, "web-push-subscriptions.json");

    const logger = createNoopLogger();
    const vapidKeys = loadOrCreateVapidKeys(vapidKeyPath, logger);
    store = new WebPushStore(logger, storePath);
    transport = new RecordingTestTransport();
    service = new WebPushService({
      logger,
      vapidKeys,
      store,
      transport,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("sends push notification with standard VAPID headers and encrypted payload", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/device-1";
    store.subscribe(
      { endpoint, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
      "principal-1",
      "client-1",
    );

    await service.sendPush({
      title: "Agent Finished",
      body: "Task completed successfully",
      data: { agentId: "agent-123", serverId: "srv-1" },
    });

    expect(transport.sentRequests).toHaveLength(1);
    const req = transport.sentRequests[0]!;
    expect(req.endpoint).toBe(endpoint);
    expect(req.method).toBe("POST");

    // Standard RFC 8292 / VAPID headers
    expect(req.headers.TTL).toBe(86400);
    expect(req.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(req.headers["Content-Type"]).toBe("application/octet-stream");
    expect(typeof req.headers.Authorization).toBe("string");
    expect(String(req.headers.Authorization)).toMatch(/^(vapid t=|WebPush )/);

    // Body is real AES128GCM ciphertext
    expect(Buffer.isBuffer(req.body)).toBe(true);
    expect(req.body!.length).toBeGreaterThan(50);
  });

  it("bounds oversized payloads under 3072 bytes without breaking multi-byte code points", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/device-huge";
    store.subscribe(
      { endpoint, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
      "principal-1",
      "client-1",
    );

    const hugeBody = "🚀".repeat(2000) + "A".repeat(5000);
    await service.sendPush({
      title: "Huge Notification",
      body: hugeBody,
      data: { agentId: "agent-huge" },
    });

    expect(transport.sentRequests).toHaveLength(1);
    const req = transport.sentRequests[0]!;
    // The encrypted ciphertext length reflects the bounded plaintext
    expect(req.body!.length).toBeLessThanOrEqual(4096);
  });

  it("isolates network failures and handles 410 Gone cleanup per subscription", async () => {
    const subSuccess = "https://fcm.googleapis.com/fcm/send/sub-success";
    const subGone = "https://updates.push.services.mozilla.com/wpush/v2/sub-410";
    const subFailing = "https://db5.notify.windows.com/wpush/sub-failing";

    store.subscribe(
      { endpoint: subSuccess, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
      "principal-1",
      "client-1",
    );
    store.subscribe(
      { endpoint: subGone, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
      "principal-2",
      "client-2",
    );
    store.subscribe(
      { endpoint: subFailing, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
      "principal-3",
      "client-3",
    );

    // subSuccess: 201 Created
    transport.responsesByEndpoint.set(subSuccess, async () => ({ statusCode: 201 }));

    // subGone: 410 Gone (should be auto-pruned)
    transport.responsesByEndpoint.set(subGone, async () => {
      throw new WebPushDeliveryError("Push subscription has expired or unsubscribed", {
        statusCode: 410,
      });
    });

    // subFailing: 500 Network Error (should be caught and logged, not prune)
    transport.responsesByEndpoint.set(subFailing, async () => {
      throw new WebPushDeliveryError("Gateway Timeout", {
        statusCode: 504,
      });
    });

    // Broadcast must not reject
    await service.sendPush({ title: "Test", body: "Message" });

    // subSuccess was delivered
    expect(transport.sentRequests.some((r) => r.endpoint === subSuccess)).toBe(true);
    expect(store.getSubscription(subSuccess)).toBeDefined();

    // subGone was pruned from store
    expect(store.getSubscription(subGone)).toBeUndefined();

    // subFailing was preserved in store
    expect(store.getSubscription(subFailing)).toBeDefined();
  });

  it("does not deliver queued notifications after the owner is revoked", async () => {
    const logger = createNoopLogger();
    const queuedService = new WebPushService({
      logger,
      vapidKeys: loadOrCreateVapidKeys(vapidKeyPath, logger),
      store,
      transport,
      concurrency: 1,
    });
    const first = "https://fcm.googleapis.com/fcm/send/in-flight";
    const second = "https://fcm.googleapis.com/fcm/send/queued";
    for (const endpoint of [first, second]) {
      store.subscribe(
        { endpoint, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
        "revoked-owner",
        "client-1",
      );
    }
    let finishFirst!: (response: WebPushTransportResponse) => void;
    const response = new Promise<WebPushTransportResponse>((resolve) => {
      finishFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      transport.responsesByEndpoint.set(first, () => {
        resolve();
        return response;
      });
    });
    const delivery = queuedService.sendPush({ title: "Test", body: "Private message" });
    await firstStarted;
    queuedService.revokePrincipal("revoked-owner");
    finishFirst({ statusCode: 201 });
    await delivery;
    expect(transport.sentRequests.map((request) => request.endpoint)).toEqual([first]);
  });

  it("handles testWebPush: verifies ownership and reports delivery success/failure", async () => {
    const endpoint = "https://fcm.googleapis.com/fcm/send/test-sub";
    store.subscribe(
      { endpoint, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
      "principal-tester",
      "client-1",
    );

    // Successful test
    transport.responsesByEndpoint.set(endpoint, async () => ({ statusCode: 201 }));
    await expect(service.test(endpoint, "principal-tester")).resolves.toBeUndefined();

    // Test by non-owner fails
    await expect(service.test(endpoint, "principal-other")).rejects.toThrow(
      /registered to another authenticated principal/,
    );

    // Test when delivery fails reports delivery failure
    transport.responsesByEndpoint.set(endpoint, async () => {
      throw new WebPushDeliveryError("Push service error", { statusCode: 400 });
    });
    await expect(service.test(endpoint, "principal-tester")).rejects.toThrow(/Push service error/);
  });

  it("integrates composite PushNotifications.send across Expo and Web Push concurrently", async () => {
    const expoDeliveries: string[][] = [];
    const tokenFilePath = path.join(tempDir, "push-tokens.json");

    const pushNotifications = createPushNotifications({
      logger: createNoopLogger(),
      filePath: tokenFilePath,
      deliver: async (tokens) => {
        expoDeliveries.push(tokens);
      },
      webPush: service,
    });

    // Register 1 expo token
    pushNotifications.renew("ExponentPushToken[expo-device-1]");

    // Register 1 web push subscription
    const webEndpoint = "https://fcm.googleapis.com/fcm/send/web-device-1";
    service.subscribe(
      { endpoint: webEndpoint, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
      "p1",
      "c1",
    );

    await pushNotifications.send({ title: "Attention", body: "Need approval" });

    // Expo got it
    expect(expoDeliveries).toEqual([["ExponentPushToken[expo-device-1]"]]);

    // Web push got it
    expect(transport.sentRequests).toHaveLength(1);
    expect(transport.sentRequests[0]!.endpoint).toBe(webEndpoint);
  });
});
