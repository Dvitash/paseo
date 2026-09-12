import type { ConnectionState } from "@getpaseo/client/internal/daemon-client";
import type { ServerInfoStatusPayload, WebPushSubscription } from "@getpaseo/protocol/messages";

export type { WebPushSubscription };

export interface WebPushConfig {
  publicKey: string;
}

export interface WebPushDaemonClient {
  readonly isConnected: boolean;
  getLastServerInfoMessage(): ServerInfoStatusPayload | null;
  getWebPushConfig(): Promise<WebPushConfig>;
  subscribeWebPush(subscription: WebPushSubscription, requestId?: string): Promise<void>;
  unsubscribeWebPush(endpoint: string, requestId?: string): Promise<void>;
  testWebPush(endpoint: string, requestId?: string): Promise<void>;
  subscribeConnectionStatus(listener: (state: ConnectionState) => void): () => void;
  on(event: "status", listener: () => void): () => void;
}

export type WebPushEnvironmentStatus =
  | "supported"
  | "unsupported-insecure-context"
  | "unsupported-browser"
  | "unsupported-ios-homescreen";

export interface WebPushBrowserAdapter {
  isSupported(): boolean;
  getEnvironmentStatus(): WebPushEnvironmentStatus;
  getPermission(): Promise<NotificationPermission | "unsupported">;
  requestPermission(): Promise<NotificationPermission | "unsupported">;
  getSubscription(serverId: string): Promise<WebPushSubscription | null>;
  subscribe(serverId: string, applicationServerKey: string): Promise<WebPushSubscription>;
  unsubscribe(serverId: string): Promise<boolean>;
  getApplicationServerKey(serverId: string): Promise<string | null>;
}

export interface WebPushStorage {
  isOptedIn(serverId: string): Promise<boolean>;
  setOptedIn(serverId: string, optedIn: boolean): Promise<void>;
  getEndpoint(serverId: string): Promise<string | null>;
  setEndpoint(serverId: string, endpoint: string | null): Promise<void>;
  getVapidKey(serverId: string): Promise<string | null>;
  setVapidKey(serverId: string, key: string | null): Promise<void>;
  clear(serverId: string): Promise<void>;
}

export interface WebPushOperationError {
  operation: "enable" | "disable" | "test" | "reconcile";
  message: string;
}

export type WebPushHostStatus =
  | { kind: "unsupported-insecure" }
  | { kind: "unsupported-browser" }
  | { kind: "unsupported-ios-homescreen" }
  | { kind: "permission-denied" }
  | { kind: "update-required" }
  | { kind: "disconnected" }
  | { kind: "disabled"; error?: WebPushOperationError | null }
  | { kind: "enabling" }
  | {
      kind: "enabled";
      endpoint: string;
      operation?: "idle" | "disabling" | "testing";
      error?: WebPushOperationError | null;
    };
