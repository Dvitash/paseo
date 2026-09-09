import crypto from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRIVATE_FILE_MODE } from "../private-files.js";
import {
  MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL,
  WEB_PUSH_LEASE_MS,
  WebPushStore,
} from "./web-push-store.js";

const MODE_MASK = 0o777;

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

function createLoggingSpy() {
  const logEntries: string[] = [];
  const logger = pino(
    { level: "debug" },
    {
      write: (message: string) => {
        logEntries.push(message);
      },
    },
  );
  return { logger, logEntries };
}

describe("WebPushStore", () => {
  let tempDir: string;
  let storePath: string;
  let simulatedNow: number;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "web-push-store-test-"));
    storePath = path.join(tempDir, "web-push-subscriptions.json");
    simulatedNow = Date.parse("2026-09-09T10:00:00.000Z");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("persists subscriptions to disk with mode 0600 permissions", () => {
    const { logger } = createLoggingSpy();
    const store = new WebPushStore(logger, storePath, () => simulatedNow);

    store.subscribe(
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/token-1",
        keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
      },
      "principal-1",
      "client-1",
    );

    expect(existsSync(storePath)).toBe(true);
    if (process.platform !== "win32") {
      const mode = statSync(storePath).mode & MODE_MASK;
      expect(mode).toBe(PRIVATE_FILE_MODE);
    }

    const saved = JSON.parse(readFileSync(storePath, "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.subscriptions).toHaveLength(1);
    expect(saved.subscriptions[0].endpoint).toBe("https://fcm.googleapis.com/fcm/send/token-1");
    expect(saved.subscriptions[0].principalId).toBe("principal-1");
    expect(saved.subscriptions[0].clientId).toBe("client-1");
  });

  it("prevents overwriting an endpoint owned by a different principal or client", () => {
    const { logger } = createLoggingSpy();
    const store = new WebPushStore(logger, storePath, () => simulatedNow);
    const endpoint = "https://fcm.googleapis.com/fcm/send/shared-token";

    store.subscribe(
      {
        endpoint,
        keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
      },
      "principal-owner",
      "client-owner",
    );

    // Different principal fails
    expect(() =>
      store.subscribe(
        {
          endpoint,
          keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
        },
        "principal-intruder",
        "client-owner",
      ),
    ).toThrow(/already registered to another authenticated/);

    // Same principal but different client fails
    expect(() =>
      store.subscribe(
        {
          endpoint,
          keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
        },
        "principal-owner",
        "client-other-tab",
      ),
    ).toThrow(/already registered to another authenticated/);
  });

  it("allows re-subscribing by same owner to update keys and renew 48h lease", () => {
    const { logger } = createLoggingSpy();
    const store = new WebPushStore(logger, storePath, () => simulatedNow);
    const endpoint = "https://fcm.googleapis.com/fcm/send/token-renew";

    const initialKeys = { auth: generateValidAuth(), p256dh: generateValidP256dh() };
    store.subscribe({ endpoint, keys: initialKeys }, "principal-1", "client-1");

    simulatedNow += 24 * 60 * 60 * 1000; // 24 hours later
    const updatedKeys = { auth: generateValidAuth(), p256dh: generateValidP256dh() };
    store.subscribe({ endpoint, keys: updatedKeys }, "principal-1", "client-1");

    const sub = store.getSubscription(endpoint);
    expect(sub).toBeDefined();
    expect(sub?.keys).toEqual(updatedKeys);
    expect(sub?.expiresAt).toBe(simulatedNow + WEB_PUSH_LEASE_MS);
  });

  it("allows unsubscribe only by the owning principal and client", () => {
    const { logger } = createLoggingSpy();
    const store = new WebPushStore(logger, storePath, () => simulatedNow);
    const endpoint = "https://fcm.googleapis.com/fcm/send/token-unsub";

    store.subscribe(
      { endpoint, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
      "principal-owner",
      "client-owner",
    );

    // Different principal fails
    expect(() => store.unsubscribe(endpoint, "principal-other", "client-owner")).toThrow(
      /Not authorized to unsubscribe/,
    );

    // Different client fails
    expect(() => store.unsubscribe(endpoint, "principal-owner", "client-other")).toThrow(
      /Not authorized to unsubscribe/,
    );

    // True owner succeeds
    expect(store.unsubscribe(endpoint, "principal-owner", "client-owner")).toBe(true);
    expect(store.getSubscription(endpoint)).toBeUndefined();

    // Idempotent unsubscribe for non-existent endpoint
    expect(store.unsubscribe(endpoint, "principal-owner", "client-owner")).toBe(false);
  });

  it("revokes all subscriptions for principal across all clients when permissions are lost", () => {
    const { logger } = createLoggingSpy();
    const store = new WebPushStore(logger, storePath, () => simulatedNow);

    store.subscribe(
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/p1-c1",
        keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
      },
      "principal-target",
      "client-1",
    );

    store.subscribe(
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/p1-c2",
        keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
      },
      "principal-target",
      "client-2",
    );

    store.subscribe(
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/p2-c1",
        keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
      },
      "principal-keep",
      "client-1",
    );

    const removed = store.revokePrincipal("principal-target");
    expect(removed).toBe(2);

    expect(store.getSubscription("https://fcm.googleapis.com/fcm/send/p1-c1")).toBeUndefined();
    expect(store.getSubscription("https://fcm.googleapis.com/fcm/send/p1-c2")).toBeUndefined();
    expect(store.getSubscription("https://fcm.googleapis.com/fcm/send/p2-c1")).toBeDefined();
  });

  it("removes single endpoint on 410/404 cleanup regardless of owner", () => {
    const { logger } = createLoggingSpy();
    const store = new WebPushStore(logger, storePath, () => simulatedNow);
    const endpoint = "https://fcm.googleapis.com/fcm/send/gone-410";

    store.subscribe(
      { endpoint, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
      "principal-1",
      "client-1",
    );

    expect(store.removeEndpoint(endpoint)).toBe(true);
    expect(store.getSubscription(endpoint)).toBeUndefined();
  });

  it("evicts oldest subscription for principal when exceeding MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL", () => {
    const { logger } = createLoggingSpy();
    const store = new WebPushStore(logger, storePath, () => simulatedNow);

    for (let i = 0; i < MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL; i++) {
      simulatedNow += 1000;
      store.subscribe(
        {
          endpoint: `https://fcm.googleapis.com/fcm/send/token-${i}`,
          keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
        },
        "principal-heavy",
        `client-${i}`,
      );
    }

    expect(store.getActiveSubscriptions()).toHaveLength(MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL);

    // Register 21st subscription: should evict oldest (token-0)
    simulatedNow += 1000;
    store.subscribe(
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/token-newest",
        keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
      },
      "principal-heavy",
      "client-newest",
    );

    expect(store.getActiveSubscriptions()).toHaveLength(MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL);
    expect(store.getSubscription("https://fcm.googleapis.com/fcm/send/token-0")).toBeUndefined();
    expect(store.getSubscription("https://fcm.googleapis.com/fcm/send/token-newest")).toBeDefined();
  });

  it("prunes expired subscriptions older than 48 hours", () => {
    const { logger } = createLoggingSpy();
    const store = new WebPushStore(logger, storePath, () => simulatedNow);
    const endpoint = "https://fcm.googleapis.com/fcm/send/token-exp";

    store.subscribe(
      { endpoint, keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() } },
      "principal-1",
      "client-1",
    );

    expect(store.getActiveSubscriptions()).toHaveLength(1);

    // Advance past 48h lease
    simulatedNow += WEB_PUSH_LEASE_MS + 1000;

    expect(store.getActiveSubscriptions()).toHaveLength(0);
    expect(store.getSubscription(endpoint)).toBeUndefined();
  });

  it("revokes in-memory delivery authority even when persistence fails", () => {
    const { logger } = createLoggingSpy();
    const parent = path.join(tempDir, "blocked");
    const store = new WebPushStore(logger, path.join(parent, "subscriptions.json"));
    store.subscribe(
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/revoked",
        keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
      },
      "revoked-owner",
      "client-1",
    );
    rmSync(parent, { recursive: true });
    writeFileSync(parent, "not a directory");
    expect(() => store.revokePrincipal("revoked-owner")).toThrow();
    expect(store.getActiveSubscriptions()).toEqual([]);
  });

  it("never logs raw endpoints or keys", () => {
    const { logger, logEntries } = createLoggingSpy();
    const store = new WebPushStore(logger, storePath, () => simulatedNow);
    const secretEndpoint = "https://fcm.googleapis.com/fcm/send/secret-device-endpoint-xyz";
    const secretAuth = generateValidAuth();
    const secretP256dh = generateValidP256dh();

    store.subscribe(
      { endpoint: secretEndpoint, keys: { auth: secretAuth, p256dh: secretP256dh } },
      "principal-test",
      "client-test",
    );

    const stringifiedLogs = JSON.stringify(logEntries);
    expect(stringifiedLogs).not.toContain(secretEndpoint);
    expect(stringifiedLogs).not.toContain(secretAuth);
    expect(stringifiedLogs).not.toContain(secretP256dh);
    expect(stringifiedLogs).toContain("fcm.googleapis.com");
  });
});
