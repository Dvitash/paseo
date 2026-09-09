import { isWeb } from "@/constants/platform";
import { createWebPushBrowserAdapter } from "./web-push-adapter";
import { createAsyncStorageWebPushStorage } from "./web-push-storage";
import type {
  WebPushBrowserAdapter,
  WebPushConfig,
  WebPushDaemonClient,
  WebPushHostStatus,
  WebPushStorage,
  WebPushSubscription,
} from "./web-push-types";

export interface WebPushManagerDeps {
  adapter?: WebPushBrowserAdapter;
  storage?: WebPushStorage;
}

export class WebPushManager {
  readonly adapter: WebPushBrowserAdapter;
  readonly storage: WebPushStorage;

  private readonly statusByServerId = new Map<string, WebPushHostStatus>();
  private readonly generations = new Map<string, number>();
  private readonly removalGenerations = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<string, Set<(status: WebPushHostStatus) => void>>();

  constructor(deps?: WebPushManagerDeps) {
    this.adapter = deps?.adapter ?? createWebPushBrowserAdapter();
    this.storage = deps?.storage ?? createAsyncStorageWebPushStorage();
  }

  private nextGeneration(serverId: string): number {
    const next = (this.generations.get(serverId) ?? 0) + 1;
    this.generations.set(serverId, next);
    return next;
  }

  private isCurrentGeneration(serverId: string, gen: number): boolean {
    const removalGen = this.removalGenerations.get(serverId);
    if (removalGen !== undefined && removalGen >= gen) {
      return false;
    }
    const current = this.generations.get(serverId) ?? 0;
    return current === gen;
  }

  private runExclusive<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(serverId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.queues.set(serverId, next);
    return next;
  }

  private setStatus(serverId: string, status: WebPushHostStatus): void {
    this.statusByServerId.set(serverId, status);
    const serverListeners = this.listeners.get(serverId);
    if (serverListeners) {
      for (const listener of serverListeners) {
        listener(status);
      }
    }
  }

  subscribeStatus(serverId: string, listener: (status: WebPushHostStatus) => void): () => void {
    let set = this.listeners.get(serverId);
    if (!set) {
      set = new Set();
      this.listeners.set(serverId, set);
    }
    set.add(listener);

    const current = this.statusByServerId.get(serverId);
    if (current) {
      listener(current);
    }

    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.listeners.delete(serverId);
      }
    };
  }

  getCachedStatus(serverId: string): WebPushHostStatus | null {
    return this.statusByServerId.get(serverId) ?? null;
  }

  private isBusyStatus(status: WebPushHostStatus): boolean {
    return (
      status.kind === "enabling" ||
      (status.kind === "enabled" &&
        (status.operation === "testing" || status.operation === "disabling"))
    );
  }

  private getUnsupportedStatus(): WebPushHostStatus | null {
    switch (this.adapter.getEnvironmentStatus()) {
      case "unsupported-insecure-context":
        return { kind: "unsupported-insecure" };
      case "unsupported-ios-homescreen":
        return { kind: "unsupported-ios-homescreen" };
      case "unsupported-browser":
        return { kind: "unsupported-browser" };
      default:
        return null;
    }
  }

  private getSubscriptionStatus(
    serverId: string,
    optedIn: boolean,
    subscription: WebPushSubscription | null,
  ): WebPushHostStatus {
    const current = this.statusByServerId.get(serverId);
    const disabledError = current?.kind === "disabled" ? current.error : null;
    if (!optedIn) return { kind: "disabled", error: disabledError };
    if (subscription) {
      return {
        kind: "enabled",
        endpoint: subscription.endpoint,
        operation: current?.kind === "enabled" ? current.operation : "idle",
        error: current?.kind === "enabled" ? current.error : null,
      };
    }
    return {
      kind: "disabled",
      error: disabledError ?? {
        operation: "reconcile",
        message: "Push subscription is not active in this browser. Enable to reconnect.",
      },
    };
  }

  private async getSupportedStatus(
    serverId: string,
    client?: WebPushDaemonClient | null,
  ): Promise<WebPushHostStatus> {
    if ((await this.adapter.getPermission()) === "denied") {
      return { kind: "permission-denied" };
    }
    const optedIn = await this.storage.isOptedIn(serverId);
    const subscription = await this.adapter.getSubscription(serverId);
    const isExpired =
      subscription?.expirationTime != null && subscription.expirationTime <= Date.now();
    const activeSubscription = isExpired ? null : subscription;
    if (client) {
      const serverInfo = client.getLastServerInfoMessage();
      if (!client.isConnected || !serverInfo) {
        return optedIn && activeSubscription
          ? this.getSubscriptionStatus(serverId, optedIn, activeSubscription)
          : { kind: "disconnected" };
      }
      if (serverInfo.features?.webPush !== true) {
        return { kind: "update-required" };
      }
    }
    return this.getSubscriptionStatus(serverId, optedIn, activeSubscription);
  }

  async getStatus(
    serverId: string,
    client?: WebPushDaemonClient | null,
  ): Promise<WebPushHostStatus> {
    const current = this.statusByServerId.get(serverId);
    if (current && this.isBusyStatus(current)) return current;
    const generation = this.generations.get(serverId) ?? 0;
    const status = this.getUnsupportedStatus() ?? (await this.getSupportedStatus(serverId, client));
    const latest = this.statusByServerId.get(serverId);
    if (!this.isCurrentGeneration(serverId, generation)) {
      return latest ?? { kind: "disabled", error: null };
    }
    if (latest && this.isBusyStatus(latest)) return latest;
    this.setStatus(serverId, status);
    return status;
  }

  async enable(
    serverId: string,
    client: WebPushDaemonClient,
    immediatePermissionPromise?: Promise<NotificationPermission | "unsupported">,
  ): Promise<void> {
    const opGen = this.nextGeneration(serverId);

    const permPromise = immediatePermissionPromise ?? this.adapter.requestPermission();
    const permission = await permPromise;

    if (!this.isCurrentGeneration(serverId, opGen)) {
      return;
    }

    if (permission !== "granted") {
      const status: WebPushHostStatus = { kind: "permission-denied" };
      this.setStatus(serverId, status);
      throw new Error("Notification permission was not granted");
    }

    if (!client.isConnected) {
      const errorMsg = "Host is disconnected. Connect to enable notifications.";
      this.setStatus(serverId, {
        kind: "disabled",
        error: { operation: "enable", message: errorMsg },
      });
      throw new Error(errorMsg);
    }

    const serverInfo = client.getLastServerInfoMessage();
    if (!serverInfo || serverInfo.features?.webPush !== true) {
      const errorMsg = "Host daemon update required to support Web Push notifications.";
      this.setStatus(serverId, { kind: "update-required" });
      throw new Error(errorMsg);
    }

    this.setStatus(serverId, { kind: "enabling" });

    await this.runExclusive(serverId, async () => {
      if (!this.isCurrentGeneration(serverId, opGen)) {
        return;
      }

      let config: WebPushConfig;
      try {
        config = await client.getWebPushConfig();
      } catch (error) {
        if (this.isCurrentGeneration(serverId, opGen)) {
          this.setStatus(serverId, {
            kind: "disabled",
            error: {
              operation: "enable",
              message: error instanceof Error ? error.message : "Failed to load push configuration",
            },
          });
        }
        throw error;
      }

      if (!this.isCurrentGeneration(serverId, opGen)) {
        return;
      }

      let subscription: WebPushSubscription;
      try {
        subscription = await this.adapter.subscribe(serverId, config.publicKey);
      } catch (error) {
        if (this.isCurrentGeneration(serverId, opGen)) {
          this.setStatus(serverId, {
            kind: "disabled",
            error: {
              operation: "enable",
              message: error instanceof Error ? error.message : "Failed to subscribe in browser",
            },
          });
        }
        throw error;
      }

      if (!this.isCurrentGeneration(serverId, opGen)) {
        await this.adapter.unsubscribe(serverId).catch(() => undefined);
        return;
      }

      try {
        await client.subscribeWebPush(subscription);
      } catch (error) {
        await this.adapter.unsubscribe(serverId).catch(() => undefined);
        if (this.isCurrentGeneration(serverId, opGen)) {
          this.setStatus(serverId, {
            kind: "disabled",
            error: {
              operation: "enable",
              message:
                error instanceof Error
                  ? error.message
                  : "Failed to register subscription on host daemon",
            },
          });
        }
        throw error;
      }

      if (!this.isCurrentGeneration(serverId, opGen)) {
        await this.adapter.unsubscribe(serverId).catch(() => undefined);
        return;
      }

      await this.storage.setOptedIn(serverId, true);
      await this.storage.setEndpoint(serverId, subscription.endpoint);
      await this.storage.setVapidKey(serverId, config.publicKey);

      this.setStatus(serverId, {
        kind: "enabled",
        endpoint: subscription.endpoint,
        operation: "idle",
        error: null,
      });
    });
  }

  async disable(serverId: string, client: WebPushDaemonClient | null): Promise<void> {
    const opGen = this.nextGeneration(serverId);

    const currentStatus = this.statusByServerId.get(serverId);
    const endpoint =
      currentStatus?.kind === "enabled"
        ? currentStatus.endpoint
        : ((await this.storage.getEndpoint(serverId)) ?? "");

    if (!client || !client.isConnected) {
      const message = "Cannot disable notifications while host is offline. Please reconnect first.";
      if (currentStatus?.kind === "enabled") {
        this.setStatus(serverId, {
          kind: "enabled",
          endpoint,
          operation: "idle",
          error: { operation: "disable", message },
        });
      }
      throw new Error(message);
    }

    if (currentStatus?.kind === "enabled") {
      this.setStatus(serverId, {
        kind: "enabled",
        endpoint,
        operation: "disabling",
        error: null,
      });
    }

    await this.runExclusive(serverId, async () => {
      if (!this.isCurrentGeneration(serverId, opGen)) {
        return;
      }

      const activeEndpoint =
        (await this.adapter.getSubscription(serverId))?.endpoint ??
        (await this.storage.getEndpoint(serverId));

      if (activeEndpoint) {
        try {
          await client.unsubscribeWebPush(activeEndpoint);
        } catch (error) {
          if (this.isCurrentGeneration(serverId, opGen)) {
            this.setStatus(serverId, {
              kind: "enabled",
              endpoint: activeEndpoint,
              operation: "idle",
              error: {
                operation: "disable",
                message:
                  error instanceof Error
                    ? error.message
                    : "Failed to revoke notification subscription on host",
              },
            });
          }
          throw error;
        }
      }

      if (!this.isCurrentGeneration(serverId, opGen)) {
        return;
      }

      await this.adapter.unsubscribe(serverId).catch(() => undefined);
      await this.storage.setOptedIn(serverId, false);
      await this.storage.clear(serverId);

      this.setStatus(serverId, { kind: "disabled", error: null });
    });
  }

  async revokeOnHostRemoval(serverId: string, client: WebPushDaemonClient | null): Promise<void> {
    const opGen = this.nextGeneration(serverId);
    this.removalGenerations.set(serverId, opGen);

    this.setStatus(serverId, { kind: "disabled", error: null });

    await this.runExclusive(serverId, async () => {
      if (client?.isConnected) {
        const endpoint =
          (await this.adapter.getSubscription(serverId))?.endpoint ??
          (await this.storage.getEndpoint(serverId));
        if (endpoint) {
          try {
            await client.unsubscribeWebPush(endpoint);
          } catch (error) {
            console.warn(
              "[WebPush] Failed to revoke subscription on server during host removal",
              error,
            );
          }
        }
      }

      await this.adapter.unsubscribe(serverId).catch(() => undefined);
      await this.storage.clear(serverId);
      this.statusByServerId.delete(serverId);
    });
  }

  async testNotification(serverId: string, client: WebPushDaemonClient): Promise<void> {
    const opGen = this.generations.get(serverId) ?? 0;

    const currentStatus = this.statusByServerId.get(serverId);
    const endpoint =
      currentStatus?.kind === "enabled"
        ? currentStatus.endpoint
        : ((await this.adapter.getSubscription(serverId))?.endpoint ??
          (await this.storage.getEndpoint(serverId)));

    if (!this.isCurrentGeneration(serverId, opGen)) {
      return;
    }

    if (!endpoint) {
      throw new Error("No active push subscription found.");
    }

    if (!client.isConnected) {
      const message = "Host is disconnected.";
      if (this.isCurrentGeneration(serverId, opGen)) {
        this.setStatus(serverId, {
          kind: "enabled",
          endpoint,
          operation: "idle",
          error: { operation: "test", message },
        });
      }
      throw new Error(message);
    }

    this.setStatus(serverId, {
      kind: "enabled",
      endpoint,
      operation: "testing",
      error: null,
    });

    try {
      await client.testWebPush(endpoint);
      if (this.isCurrentGeneration(serverId, opGen)) {
        this.setStatus(serverId, {
          kind: "enabled",
          endpoint,
          operation: "idle",
          error: null,
        });
      }
    } catch (error) {
      if (this.isCurrentGeneration(serverId, opGen)) {
        this.setStatus(serverId, {
          kind: "enabled",
          endpoint,
          operation: "idle",
          error: {
            operation: "test",
            message: error instanceof Error ? error.message : "Failed to send test notification",
          },
        });
      }
      throw error;
    }
  }

  private async canReconcile(serverId: string, generation: number): Promise<boolean> {
    const optedIn = await this.storage.isOptedIn(serverId);
    return optedIn && this.isCurrentGeneration(serverId, generation);
  }

  private async replaceSubscription(
    serverId: string,
    client: WebPushDaemonClient,
    config: WebPushConfig,
    existing: WebPushSubscription | null,
    generation: number,
  ): Promise<void> {
    if (existing) await this.adapter.unsubscribe(serverId).catch(() => undefined);
    if (!(await this.canReconcile(serverId, generation))) return;

    let subscription: WebPushSubscription;
    try {
      subscription = await this.adapter.subscribe(serverId, config.publicKey);
    } catch {
      return;
    }
    if (!(await this.canReconcile(serverId, generation))) {
      await this.adapter.unsubscribe(serverId).catch(() => undefined);
      return;
    }
    try {
      await client.subscribeWebPush(subscription);
    } catch {
      await this.adapter.unsubscribe(serverId).catch(() => undefined);
      return;
    }
    if (!(await this.canReconcile(serverId, generation))) {
      await this.adapter.unsubscribe(serverId).catch(() => undefined);
      return;
    }
    await this.storage.setEndpoint(serverId, subscription.endpoint);
    await this.storage.setVapidKey(serverId, config.publicKey);
    if (!this.isCurrentGeneration(serverId, generation)) return;
    this.setStatus(serverId, {
      kind: "enabled",
      endpoint: subscription.endpoint,
      operation: "idle",
      error: null,
    });
  }

  private async refreshSubscription(
    serverId: string,
    client: WebPushDaemonClient,
    config: WebPushConfig,
    generation: number,
  ): Promise<void> {
    const existing = await this.adapter.getSubscription(serverId);
    const existingKey = await this.adapter.getApplicationServerKey(serverId);
    const storedKey = await this.storage.getVapidKey(serverId);
    const keyRotated =
      (existingKey !== null && existingKey !== config.publicKey) ||
      (storedKey !== null && storedKey !== config.publicKey);
    const isExpired = existing?.expirationTime != null && existing.expirationTime <= Date.now();
    if (!(await this.canReconcile(serverId, generation))) return;
    if (!existing || isExpired || keyRotated) {
      await this.replaceSubscription(serverId, client, config, existing, generation);
      return;
    }
    try {
      await client.subscribeWebPush(existing);
      if (!(await this.canReconcile(serverId, generation))) return;
      this.setStatus(serverId, {
        kind: "enabled",
        endpoint: existing.endpoint,
        operation: "idle",
        error: null,
      });
    } catch {
      // A lease refresh failure does not invalidate an existing browser subscription.
    }
  }

  async reconcile(serverId: string, client: WebPushDaemonClient): Promise<void> {
    const generation = this.generations.get(serverId) ?? 0;
    if (!(await this.storage.isOptedIn(serverId))) return;
    await this.runExclusive(serverId, async () => {
      if (!(await this.canReconcile(serverId, generation))) return;
      const permission = await this.adapter.getPermission();
      if (!this.isCurrentGeneration(serverId, generation)) return;
      if (permission !== "granted") {
        if (permission === "denied") this.setStatus(serverId, { kind: "permission-denied" });
        return;
      }
      if (!client.isConnected) return;
      const serverInfo = client.getLastServerInfoMessage();
      if (serverInfo?.features?.webPush !== true) return;
      let config: WebPushConfig;
      try {
        config = await client.getWebPushConfig();
      } catch {
        return;
      }
      if (!(await this.canReconcile(serverId, generation))) return;
      await this.refreshSubscription(serverId, client, config, generation);
    });
  }

  startSubscription(input: { client: WebPushDaemonClient; serverId: string }): () => void {
    let stopped = false;

    const runReconcile = () => {
      if (!stopped && input.client.isConnected) {
        void this.reconcile(input.serverId, input.client);
      }
    };

    runReconcile();

    const unsubscribeConn = input.client.subscribeConnectionStatus?.((state) => {
      if (state.status === "connected") {
        runReconcile();
      }
    });

    const unsubscribeStatus = input.client.on?.("status", () => {
      runReconcile();
    });

    const onVisibilityChange = () => {
      if (
        isWeb &&
        !stopped &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      ) {
        runReconcile();
      }
    };

    if (isWeb && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }

    return () => {
      stopped = true;
      unsubscribeConn?.();
      unsubscribeStatus?.();
      if (isWeb && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
    };
  }
}

let defaultManager: WebPushManager | null = null;

export function getWebPushManager(): WebPushManager {
  if (!defaultManager) {
    defaultManager = new WebPushManager();
  }
  return defaultManager;
}
