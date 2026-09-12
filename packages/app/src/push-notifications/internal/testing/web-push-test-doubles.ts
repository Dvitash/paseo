import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import type { ServerInfoStatusPayload, WebPushSubscription } from "@getpaseo/protocol/messages";
import { getHostScope } from "../web-push-adapter";
import type {
  WebPushBrowserAdapter,
  WebPushConfig,
  WebPushDaemonClient,
  WebPushEnvironmentStatus,
  WebPushStorage,
} from "../web-push-types";

export interface InMemoryBrowserAdapterOptions {
  environmentStatus?: WebPushEnvironmentStatus;
  permission?: NotificationPermission | "unsupported";
}

export interface InMemoryWebPushBrowserAdapter extends WebPushBrowserAdapter {
  setEnvironmentStatus(status: WebPushEnvironmentStatus): void;
  setPermission(permission: NotificationPermission | "unsupported"): void;
  setNextSubscribeError(error: Error | null): void;
  getScopedRegistrations(): string[];
}

export function createInMemoryWebPushBrowserAdapter(
  options?: InMemoryBrowserAdapterOptions,
): InMemoryWebPushBrowserAdapter {
  let environmentStatus: WebPushEnvironmentStatus = options?.environmentStatus ?? "supported";
  let permission: NotificationPermission | "unsupported" = options?.permission ?? "default";
  let nextSubscribeError: Error | null = null;

  const subscriptions = new Map<string, WebPushSubscription>();
  const applicationServerKeys = new Map<string, string>();
  const registeredScopes = new Set<string>();

  return {
    setEnvironmentStatus(status: WebPushEnvironmentStatus) {
      environmentStatus = status;
    },

    setPermission(nextPermission: NotificationPermission | "unsupported") {
      permission = nextPermission;
    },

    setNextSubscribeError(error: Error | null) {
      nextSubscribeError = error;
    },

    getScopedRegistrations(): string[] {
      return Array.from(registeredScopes);
    },

    isSupported(): boolean {
      return environmentStatus === "supported";
    },

    getEnvironmentStatus(): WebPushEnvironmentStatus {
      return environmentStatus;
    },

    async getPermission(): Promise<NotificationPermission | "unsupported"> {
      return permission;
    },

    async requestPermission(): Promise<NotificationPermission | "unsupported"> {
      if (permission === "default") {
        permission = "granted";
      }
      return permission;
    },

    async getSubscription(serverId: string): Promise<WebPushSubscription | null> {
      return subscriptions.get(serverId) ?? null;
    },

    async subscribe(serverId: string, applicationServerKey: string): Promise<WebPushSubscription> {
      if (nextSubscribeError) {
        const err = nextSubscribeError;
        nextSubscribeError = null;
        throw err;
      }

      const scope = getHostScope(serverId);
      registeredScopes.add(scope);

      const subscription: WebPushSubscription = {
        endpoint: `https://push.example.com/sub/${encodeURIComponent(serverId)}`,
        keys: {
          p256dh: `mock-p256dh-${serverId}`,
          auth: `mock-auth-${serverId}`,
        },
        expirationTime: null,
      };

      subscriptions.set(serverId, subscription);
      applicationServerKeys.set(serverId, applicationServerKey);

      return subscription;
    },

    async unsubscribe(serverId: string): Promise<boolean> {
      const scope = getHostScope(serverId);
      registeredScopes.delete(scope);
      applicationServerKeys.delete(serverId);
      const had = subscriptions.has(serverId);
      subscriptions.delete(serverId);
      return had;
    },

    async getApplicationServerKey(serverId: string): Promise<string | null> {
      return applicationServerKeys.get(serverId) ?? null;
    },
  };
}

export function createInMemoryWebPushStorage(): WebPushStorage {
  const map = new Map<string, string>();

  return {
    async isOptedIn(serverId: string): Promise<boolean> {
      return map.get(`opt-in:${serverId}`) === "true";
    },

    async setOptedIn(serverId: string, optedIn: boolean): Promise<void> {
      if (optedIn) {
        map.set(`opt-in:${serverId}`, "true");
      } else {
        map.delete(`opt-in:${serverId}`);
      }
    },

    async getEndpoint(serverId: string): Promise<string | null> {
      return map.get(`endpoint:${serverId}`) ?? null;
    },

    async setEndpoint(serverId: string, endpoint: string | null): Promise<void> {
      if (endpoint) {
        map.set(`endpoint:${serverId}`, endpoint);
      } else {
        map.delete(`endpoint:${serverId}`);
      }
    },

    async getVapidKey(serverId: string): Promise<string | null> {
      return map.get(`vapid:${serverId}`) ?? null;
    },

    async setVapidKey(serverId: string, key: string | null): Promise<void> {
      if (key) {
        map.set(`vapid:${serverId}`, key);
      } else {
        map.delete(`vapid:${serverId}`);
      }
    },

    async clear(serverId: string): Promise<void> {
      map.delete(`opt-in:${serverId}`);
      map.delete(`endpoint:${serverId}`);
      map.delete(`vapid:${serverId}`);
    },
  };
}

export interface FakeDaemonClientOptions {
  isConnected?: boolean;
  webPushFeature?: boolean;
  publicKey?: string;
  onSubscribe?: (sub: WebPushSubscription) => Promise<void>;
  onUnsubscribe?: (endpoint: string) => Promise<void>;
  onTest?: (endpoint: string) => Promise<void>;
}

export interface FakeDaemonClient extends WebPushDaemonClient {
  isConnected: boolean;
  setIsConnected(connected: boolean): void;
  subscribed: WebPushSubscription[];
  unsubscribedEndpoints: string[];
  testEndpoints: string[];
  simulateStatusEvent(): void;
  simulateConnectionStateChange(state: ConnectionState): void;
}

export function createFakeDaemonClient(options?: FakeDaemonClientOptions): FakeDaemonClient {
  const subscribed: WebPushSubscription[] = [];
  const unsubscribedEndpoints: string[] = [];
  const testEndpoints: string[] = [];
  const statusListeners = new Set<() => void>();
  const connectionListeners = new Set<(state: ConnectionState) => void>();

  let isConnected = options?.isConnected ?? true;
  let webPushFeature = options?.webPushFeature ?? true;
  let publicKey = options?.publicKey ?? "test-vapid-public-key-1";

  return {
    get isConnected() {
      return isConnected;
    },
    set isConnected(val: boolean) {
      isConnected = val;
    },
    setIsConnected(val: boolean) {
      isConnected = val;
    },
    subscribed,
    unsubscribedEndpoints,
    testEndpoints,

    getLastServerInfoMessage(): ServerInfoStatusPayload | null {
      if (!isConnected) {
        return null;
      }
      return {
        status: "server_info",
        serverId: "test-server",
        hostname: "test-host",
        version: "1.0.0",
        features: {
          webPush: webPushFeature,
        },
      };
    },

    async getWebPushConfig(): Promise<WebPushConfig> {
      return { publicKey };
    },

    async subscribeWebPush(sub: WebPushSubscription): Promise<void> {
      if (options?.onSubscribe) {
        await options.onSubscribe(sub);
      }
      subscribed.push(sub);
    },

    async unsubscribeWebPush(endpoint: string): Promise<void> {
      if (options?.onUnsubscribe) {
        await options.onUnsubscribe(endpoint);
      }
      unsubscribedEndpoints.push(endpoint);
    },

    async testWebPush(endpoint: string): Promise<void> {
      if (options?.onTest) {
        await options.onTest(endpoint);
      }
      testEndpoints.push(endpoint);
    },

    subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void {
      connectionListeners.add(listener);
      return () => {
        connectionListeners.delete(listener);
      };
    },

    on(event: "status", listener: () => void): () => void {
      if (event === "status") {
        statusListeners.add(listener);
        return () => {
          statusListeners.delete(listener);
        };
      }
      return () => undefined;
    },

    simulateStatusEvent(): void {
      for (const listener of statusListeners) {
        listener();
      }
    },

    simulateConnectionStateChange(state: ConnectionState): void {
      for (const listener of connectionListeners) {
        listener(state);
      }
    },
  };
}
