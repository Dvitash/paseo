import { describe, expect, it } from "vitest";
import {
  createFakeDaemonClient,
  createInMemoryWebPushBrowserAdapter,
  createInMemoryWebPushStorage,
} from "./testing/web-push-test-doubles";
import { isExactHostScope, waitForActiveWorker } from "./web-push-adapter";
import { WebPushManager } from "./web-push-manager";

describe("WebPushManager", () => {
  it("explicit opt-in: enables push notifications through user gesture and stores intent", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "default" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    const initialStatus = await manager.getStatus("host-1", client);
    expect(initialStatus).toEqual({ kind: "disabled", error: null });

    await manager.enable("host-1", client);

    expect(await adapter.getPermission()).toBe("granted");
    expect(adapter.getScopedRegistrations()).toContain("/_paseo/push/host-1/");
    expect(client.subscribed.length).toBe(1);
    expect(client.subscribed[0].endpoint).toBe("https://push.example.com/sub/host-1");
    expect(await storage.isOptedIn("host-1")).toBe(true);
    expect(await storage.getEndpoint("host-1")).toBe("https://push.example.com/sub/host-1");
    expect(await storage.getVapidKey("host-1")).toBe("test-vapid-public-key-1");

    const statusAfter = await manager.getStatus("host-1", client);
    expect(statusAfter).toEqual({
      kind: "enabled",
      endpoint: "https://push.example.com/sub/host-1",
      operation: "idle",
      error: null,
    });
  });

  it("no prompt on reconnect: refreshes existing opted-in subscription without requesting permission", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    await storage.setOptedIn("host-1", true);
    await storage.setEndpoint("host-1", "https://push.example.com/sub/host-1");
    await storage.setVapidKey("host-1", "test-vapid-public-key-1");
    await adapter.subscribe("host-1", "test-vapid-public-key-1");

    let permissionPrompted = false;
    const originalRequest = adapter.requestPermission;
    adapter.requestPermission = async () => {
      permissionPrompted = true;
      return originalRequest();
    };

    await manager.reconcile("host-1", client);

    expect(permissionPrompted).toBe(false);
    expect(client.subscribed.length).toBe(1);
    expect(client.subscribed[0].endpoint).toBe("https://push.example.com/sub/host-1");

    await manager.reconcile("host-2", client);
    expect(client.subscribed.length).toBe(1);
    expect(await adapter.getSubscription("host-2")).toBeNull();
  });

  it("multi-host scope: isolates subscriptions and scopes per host", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });

    const clientAlpha = createFakeDaemonClient({ publicKey: "vapid-alpha" });
    const clientBeta = createFakeDaemonClient({ publicKey: "vapid-beta" });

    await manager.enable("alpha", clientAlpha);
    await manager.enable("beta", clientBeta);

    const scopes = adapter.getScopedRegistrations();
    expect(scopes).toContain("/_paseo/push/alpha/");
    expect(scopes).toContain("/_paseo/push/beta/");
    expect(await adapter.getApplicationServerKey("alpha")).toBe("vapid-alpha");
    expect(await adapter.getApplicationServerKey("beta")).toBe("vapid-beta");

    await manager.disable("alpha", clientAlpha);

    expect(await storage.isOptedIn("alpha")).toBe(false);
    expect(await adapter.getSubscription("alpha")).toBeNull();
    expect(adapter.getScopedRegistrations()).not.toContain("/_paseo/push/alpha/");

    expect(await storage.isOptedIn("beta")).toBe(true);
    expect(await adapter.getSubscription("beta")).not.toBeNull();
    expect(adapter.getScopedRegistrations()).toContain("/_paseo/push/beta/");
  });

  it("permissions failures: transitions to permission-denied without subscribing", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "denied" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    await expect(manager.enable("host-1", client)).rejects.toThrow();

    expect(await storage.isOptedIn("host-1")).toBe(false);
    expect(await adapter.getSubscription("host-1")).toBeNull();
    expect(client.subscribed.length).toBe(0);

    const status = await manager.getStatus("host-1", client);
    expect(status).toEqual({ kind: "permission-denied" });
  });

  it("subscribe failure in browser: cleans up and reports error without storing opt-in", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "default" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    adapter.setNextSubscribeError(new Error("Browser PushManager quota exceeded"));

    await expect(manager.enable("host-1", client)).rejects.toThrow(
      "Browser PushManager quota exceeded",
    );

    expect(await storage.isOptedIn("host-1")).toBe(false);
    expect(client.subscribed.length).toBe(0);
    expect(manager.getCachedStatus("host-1")).toEqual({
      kind: "disabled",
      error: {
        operation: "enable",
        message: "Browser PushManager quota exceeded",
      },
    });
  });

  it("subscribe failure on daemon: rolls back browser subscription and does not report enabled", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "default" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient({
      onSubscribe: async () => {
        throw new Error("Daemon SQLite write error");
      },
    });

    await expect(manager.enable("host-1", client)).rejects.toThrow("Daemon SQLite write error");

    expect(await adapter.getSubscription("host-1")).toBeNull();
    expect(await storage.isOptedIn("host-1")).toBe(false);

    expect(manager.getCachedStatus("host-1")).toEqual({
      kind: "disabled",
      error: {
        operation: "enable",
        message: "Daemon SQLite write error",
      },
    });
  });

  it("disable / late-async race: generation cancellation prevents in-flight enable from re-enabling", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });

    let finishServerSubscribe: () => void = () => undefined;
    const serverSubscribePending = new Promise<void>((resolve) => {
      finishServerSubscribe = resolve;
    });

    const client = createFakeDaemonClient({
      onSubscribe: async () => {
        await serverSubscribePending;
      },
    });

    const enablePromise = manager.enable("host-1", client);
    const disablePromise = manager.disable("host-1", client);

    finishServerSubscribe();

    await Promise.allSettled([enablePromise, disablePromise]);

    expect(await storage.isOptedIn("host-1")).toBe(false);
    expect(await adapter.getSubscription("host-1")).toBeNull();
    expect(manager.getCachedStatus("host-1")).toEqual({ kind: "disabled", error: null });
  });

  it("disable when disconnected: refuses with clear offline error and does not report false success", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    await manager.enable("host-1", client);
    expect(await storage.isOptedIn("host-1")).toBe(true);

    client.setIsConnected(false);

    await expect(manager.disable("host-1", client)).rejects.toThrow(
      "Cannot disable notifications while host is offline",
    );

    expect(await storage.isOptedIn("host-1")).toBe(true);
    expect(await adapter.getSubscription("host-1")).not.toBeNull();
    expect(manager.getCachedStatus("host-1")).toMatchObject({
      kind: "enabled",
      error: {
        operation: "disable",
      },
    });
  });

  it("host removal when disconnected: unsubscribes locally even without server reachability", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    await manager.enable("host-1", client);
    client.setIsConnected(false);

    await manager.revokeOnHostRemoval("host-1", client);

    expect(await storage.isOptedIn("host-1")).toBe(false);
    expect(await adapter.getSubscription("host-1")).toBeNull();
    expect(manager.getCachedStatus("host-1")).toBeNull();
  });

  it("VAPID key rotation: replaces subscription when daemon publicKey changes", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient({ publicKey: "vapid-v1" });

    await manager.enable("host-1", client);
    expect(await storage.getVapidKey("host-1")).toBe("vapid-v1");
    expect(await adapter.getApplicationServerKey("host-1")).toBe("vapid-v1");

    client.getWebPushConfig = async () => ({ publicKey: "vapid-v2" });

    await manager.reconcile("host-1", client);

    expect(await storage.getVapidKey("host-1")).toBe("vapid-v2");
    expect(await adapter.getApplicationServerKey("host-1")).toBe("vapid-v2");
    expect(client.subscribed.length).toBe(2);
  });

  it("environment status gates: surfaces unsupported environments and daemon update gates", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter();
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    adapter.setEnvironmentStatus("unsupported-insecure-context");
    expect(await manager.getStatus("host-1", client)).toEqual({
      kind: "unsupported-insecure",
    });

    adapter.setEnvironmentStatus("unsupported-ios-homescreen");
    expect(await manager.getStatus("host-1", client)).toEqual({
      kind: "unsupported-ios-homescreen",
    });

    adapter.setEnvironmentStatus("unsupported-browser");
    expect(await manager.getStatus("host-1", client)).toEqual({
      kind: "unsupported-browser",
    });

    adapter.setEnvironmentStatus("supported");
    const oldDaemonClient = createFakeDaemonClient({ webPushFeature: false });
    expect(await manager.getStatus("host-1", oldDaemonClient)).toEqual({
      kind: "update-required",
    });
  });

  it("test notification: calls testWebPush with active endpoint", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    await manager.enable("host-1", client);

    await manager.testNotification("host-1", client);
    expect(client.testEndpoints).toEqual(["https://push.example.com/sub/host-1"]);
  });

  it("exact scope guard: rejects broader root scope or other host scopes", () => {
    const origin = "https://example.com";
    expect(isExactHostScope({ scope: `${origin}/` }, "host-1", origin)).toBe(false);
    expect(isExactHostScope({ scope: `${origin}/_paseo/push/host-2/` }, "host-1", origin)).toBe(
      false,
    );
    expect(isExactHostScope({ scope: `${origin}/_paseo/push/host-1/` }, "host-1", origin)).toBe(
      true,
    );
    expect(
      isExactHostScope({ scope: "https://other.example/_paseo/push/host-1/" }, "host-1", origin),
    ).toBe(false);
  });

  it("permission isolation: origin granted permission never automatically opts unconfigured hosts in", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    expect(await adapter.getPermission()).toBe("granted");

    const status = await manager.getStatus("host-1", client);
    expect(status).toEqual({ kind: "disabled", error: null });

    await manager.reconcile("host-1", client);
    expect(client.subscribed.length).toBe(0);
    expect(await storage.isOptedIn("host-1")).toBe(false);
  });

  it("initial handshake timing: delayed server_info status event triggers auto-reconciliation", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });

    await storage.setOptedIn("host-1", true);
    await storage.setEndpoint("host-1", "https://push.example.com/sub/host-1");
    await storage.setVapidKey("host-1", "vapid-1");
    await adapter.subscribe("host-1", "vapid-1");

    let serverInfoAvailable = false;
    const client = createFakeDaemonClient();
    client.getLastServerInfoMessage = () =>
      serverInfoAvailable
        ? {
            status: "server_info",
            serverId: "host-1",
            hostname: "test-host",
            version: "1.0.0",
            features: { webPush: true },
          }
        : null;

    const unsubscribe = manager.startSubscription({ client, serverId: "host-1" });
    await manager.reconcile("host-1", client);

    expect(client.subscribed.length).toBe(0);
    const reconciled = new Promise<void>((resolve) => {
      manager.subscribeStatus("host-1", (status) => {
        if (status.kind === "enabled") resolve();
      });
    });

    serverInfoAvailable = true;
    client.simulateStatusEvent();

    await reconciled;
    expect(client.subscribed.length).toBe(1);
    unsubscribe();
  });

  it("regression finding 1: waitForActiveWorker resolves activated worker immediately without ReferenceError", async () => {
    const mockWorker: ServiceWorker = {
      state: "activated",
      scriptURL: "https://example.com/push-service-worker.js",
      onstatechange: null,
      onerror: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      postMessage: () => undefined,
    };

    const registration = {
      active: null,
      installing: mockWorker,
      waiting: null,
    };
    const activated = await waitForActiveWorker(registration);
    expect(activated).toBe(mockWorker);
  });

  it("regression finding 2: queued reconciliation behind disable rechecks opt-in and does not re-enable", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });

    let finishServerUnsubscribe: () => void = () => undefined;
    const serverUnsubscribePending = new Promise<void>((resolve) => {
      finishServerUnsubscribe = resolve;
    });

    const client = createFakeDaemonClient({
      onUnsubscribe: async () => {
        await serverUnsubscribePending;
      },
    });

    await manager.enable("host-1", client);
    expect(await storage.isOptedIn("host-1")).toBe(true);
    expect(client.subscribed.length).toBe(1);

    const disablePromise = manager.disable("host-1", client);
    const reconcilePromise = manager.reconcile("host-1", client);

    finishServerUnsubscribe();

    await Promise.all([disablePromise, reconcilePromise]);

    expect(await storage.isOptedIn("host-1")).toBe(false);
    expect(await adapter.getSubscription("host-1")).toBeNull();
    expect(client.subscribed.length).toBe(1);
    expect(manager.getCachedStatus("host-1")).toEqual({ kind: "disabled", error: null });
  });

  it("regression finding 3: missing or expired browser subscription is not reported as enabled even if stored endpoint exists", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    await storage.setOptedIn("host-1", true);
    await storage.setEndpoint("host-1", "https://push.example.com/sub/old-endpoint");
    await storage.setVapidKey("host-1", "vapid-1");

    expect(await adapter.getSubscription("host-1")).toBeNull();

    const status = await manager.getStatus("host-1", client);
    expect(status.kind).toBe("disabled");
    expect(status).toMatchObject({
      kind: "disabled",
      error: {
        operation: "reconcile",
      },
    });
  });

  it("regression finding 4: test failure preserves enabled state and disable button without exposing enable", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient({
      onTest: async () => {
        throw new Error("Push gateway error 502");
      },
    });

    await manager.enable("host-1", client);
    expect(manager.getCachedStatus("host-1")).toMatchObject({ kind: "enabled" });

    await expect(manager.testNotification("host-1", client)).rejects.toThrow(
      "Push gateway error 502",
    );

    const status = manager.getCachedStatus("host-1");
    expect(status).toEqual({
      kind: "enabled",
      endpoint: "https://push.example.com/sub/host-1",
      operation: "idle",
      error: {
        operation: "test",
        message: "Push gateway error 502",
      },
    });
  });

  it("regression finding 4b: disable failure preserves enabled state with disable retry and does not invoke enable", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient({
      onUnsubscribe: async () => {
        throw new Error("Server internal error");
      },
    });

    await manager.enable("host-1", client);

    await expect(manager.disable("host-1", client)).rejects.toThrow("Server internal error");

    const status = manager.getCachedStatus("host-1");
    expect(status).toEqual({
      kind: "enabled",
      endpoint: "https://push.example.com/sub/host-1",
      operation: "idle",
      error: {
        operation: "disable",
        message: "Server internal error",
      },
    });
    expect(await storage.isOptedIn("host-1")).toBe(true);
  });

  it("subscription timeout: bounds PushManager.subscribe with timeout, releases queue, and prevents opt-in", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    adapter.setNextSubscribeError(
      new Error("Timeout subscribing to browser push service (network unreachable)"),
    );

    await expect(manager.enable("host-timeout", client)).rejects.toThrow(
      "Timeout subscribing to browser push service (network unreachable)",
    );

    expect(await storage.isOptedIn("host-timeout")).toBe(false);
    expect(manager.getCachedStatus("host-timeout")).toEqual({
      kind: "disabled",
      error: {
        operation: "enable",
        message: "Timeout subscribing to browser push service (network unreachable)",
      },
    });

    const nextStatus = await manager.getStatus("host-timeout", client);
    expect(nextStatus.kind).toBe("disabled");
  });

  it("visibility/reconcile during pending enable must NOT cancel enable", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });

    let finishServerSubscribe: () => void = () => undefined;
    const serverSubscribePending = new Promise<void>((resolve) => {
      finishServerSubscribe = resolve;
    });

    const client = createFakeDaemonClient({
      onSubscribe: async () => {
        await serverSubscribePending;
      },
    });

    const enablePromise = manager.enable("host-1", client);
    const reconcilePromise = manager.reconcile("host-1", client);

    finishServerSubscribe();

    await Promise.all([enablePromise, reconcilePromise]);

    expect(await storage.isOptedIn("host-1")).toBe(true);
    expect(client.subscribed.length).toBe(1);
    expect(manager.getCachedStatus("host-1")).toMatchObject({
      kind: "enabled",
      endpoint: "https://push.example.com/sub/host-1",
      operation: "idle",
      error: null,
    });
  });

  it("async getStatus does not overwrite an ongoing operation from newer generation", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    let finishGetPermission: () => void = () => undefined;
    const getPermissionPending = new Promise<void>((resolve) => {
      finishGetPermission = resolve;
    });

    const originalGetPermission = adapter.getPermission.bind(adapter);
    adapter.getPermission = async () => {
      await getPermissionPending;
      return originalGetPermission();
    };

    const slowGetStatusPromise = manager.getStatus("host-1", client);
    const enablePromise = manager.enable("host-1", client);

    finishGetPermission();

    await Promise.all([slowGetStatusPromise, enablePromise]);

    expect(manager.getCachedStatus("host-1")).toMatchObject({
      kind: "enabled",
      endpoint: "https://push.example.com/sub/host-1",
      operation: "idle",
      error: null,
    });
  });

  it("affirmative capability: getStatus reports disconnected when server_info is null even if connected", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    client.getLastServerInfoMessage = () => null;

    const status = await manager.getStatus("host-1", client);
    expect(status).toEqual({ kind: "disconnected" });
  });

  it("affirmative capability: enable throws update-required when server_info is null without calling getWebPushConfig", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    let getWebPushConfigCalled = false;
    client.getWebPushConfig = async () => {
      getWebPushConfigCalled = true;
      return { publicKey: "vapid-1" };
    };
    client.getLastServerInfoMessage = () => null;

    await expect(manager.enable("host-1", client)).rejects.toThrow(
      "Host daemon update required to support Web Push notifications.",
    );
    expect(getWebPushConfigCalled).toBe(false);
  });

  it("deferred regression: stale getStatus resolving after disable does not overwrite disabled with enabled", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });
    const client = createFakeDaemonClient();

    await manager.enable("host-1", client);
    expect(manager.getCachedStatus("host-1")).toMatchObject({ kind: "enabled" });

    let finishGetSubscription: () => void = () => undefined;
    const getSubscriptionPending = new Promise<void>((resolve) => {
      finishGetSubscription = resolve;
    });

    const originalGetSubscription = adapter.getSubscription.bind(adapter);
    let blockNextRead = true;
    const readStarted = new Promise<void>((resolve) => {
      adapter.getSubscription = async (serverId: string) => {
        const snapshot = await originalGetSubscription(serverId);
        if (blockNextRead) {
          blockNextRead = false;
          resolve();
          await getSubscriptionPending;
        }
        return snapshot;
      };
    });

    const slowGetStatusPromise = manager.getStatus("host-1", client);
    await readStarted;

    await manager.disable("host-1", client);
    expect(manager.getCachedStatus("host-1")).toEqual({ kind: "disabled", error: null });

    finishGetSubscription();
    await slowGetStatusPromise;

    expect(manager.getCachedStatus("host-1")).toEqual({ kind: "disabled", error: null });
  });

  it("deferred regression: late test notification completion after disable does not restore enabled", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });

    let finishTestWebPush: () => void = () => undefined;
    const testWebPushPending = new Promise<void>((resolve) => {
      finishTestWebPush = resolve;
    });

    const client = createFakeDaemonClient({
      onTest: async () => {
        await testWebPushPending;
      },
    });

    await manager.enable("host-1", client);
    expect(manager.getCachedStatus("host-1")).toMatchObject({ kind: "enabled" });

    const testPromise = manager.testNotification("host-1", client);

    await manager.disable("host-1", client);
    expect(manager.getCachedStatus("host-1")).toEqual({ kind: "disabled", error: null });

    finishTestWebPush();
    await testPromise;

    expect(manager.getCachedStatus("host-1")).toEqual({ kind: "disabled", error: null });
  });

  it("deferred regression: late test notification completion after host removal does not restore enabled", async () => {
    const adapter = createInMemoryWebPushBrowserAdapter({ permission: "granted" });
    const storage = createInMemoryWebPushStorage();
    const manager = new WebPushManager({ adapter, storage });

    let finishTestWebPush: () => void = () => undefined;
    const testWebPushPending = new Promise<void>((resolve) => {
      finishTestWebPush = resolve;
    });

    const client = createFakeDaemonClient({
      onTest: async () => {
        await testWebPushPending;
      },
    });

    await manager.enable("host-1", client);

    const testPromise = manager.testNotification("host-1", client);

    await manager.revokeOnHostRemoval("host-1", client);
    expect(manager.getCachedStatus("host-1")).toBeNull();

    finishTestWebPush();
    await testPromise;

    expect(manager.getCachedStatus("host-1")).toBeNull();
  });
});
