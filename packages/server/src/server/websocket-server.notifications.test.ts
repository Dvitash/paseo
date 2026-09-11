import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { rmSync } from "node:fs";
import type { Server as HTTPServer } from "http";
import type pino from "pino";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { ScheduleService } from "./schedule/service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { asInternals, createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import type { PushNotificationSender, PushPayload } from "./push/index.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import type { WebPushService } from "./push/web-push-service.js";

const WORKSPACE_ID = "workspace-1";
const TEST_PASEO_HOME = "/tmp/paseo-test";
const TEST_WEB_PUSH_STORE_PATH = `${TEST_PASEO_HOME}/web-push-subscriptions.json`;

function generateValidP256dh(): string {
  const { publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  return Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64url");
}

function generateValidAuth(): string {
  return crypto.randomBytes(16).toString("base64url");
}

const wsModuleMock = vi.hoisted(() => {
  class MockWebSocketServer {
    readonly handlers = new Map<string, (...args: unknown[]) => void>();

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }

    close() {
      // no-op
    }
  }

  return { MockWebSocketServer };
});

vi.mock("ws", () => ({
  WebSocketServer: wsModuleMock.MockWebSocketServer,
}));

vi.mock("./session.js", () => ({
  Session: function Session() {
    return {};
  },
}));

import { VoiceAssistantWebSocketServer } from "./websocket-server.js";

interface WebSocketServerInternals {
  sessions: Map<unknown, unknown>;
  webPushService: WebPushService | null;
  broadcastAgentAttention(params: {
    agentId: string;
    reason: string;
    preview?: string;
    providerId?: string;
    timestamp?: string;
  }): Promise<void>;
}
function createLogger() {
  const logger = {
    child: vi.fn(() => logger),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

class RecordingPushNotificationSender implements PushNotificationSender {
  readonly sent: PushPayload[] = [];
  readonly sentScopes: Array<"all" | "mobile" | undefined> = [];

  async send(payload: PushPayload, options?: { scope?: "all" | "mobile" }): Promise<void> {
    this.sent.push(payload);
    this.sentScopes.push(options?.scope);
  }
}

function createServer(agentManagerOverrides?: Record<string, unknown>) {
  const pushNotifications = new RecordingPushNotificationSender();
  const agentManager = {
    subscribe: vi.fn(() => () => {}),
    setAgentAttentionCallback: vi.fn(),
    getAgent: vi.fn(() => ({
      workspaceId: WORKSPACE_ID,
      config: { title: null },
      labels: {},
      pendingPermissions: new Map(),
    })),
    getLastAssistantMessage: vi.fn(async () => null),
    getMetricsSnapshot: vi.fn(() => ({
      total: 0,
      byLifecycle: {},
      withActiveForegroundTurn: 0,
      timelineStats: {
        totalItems: 0,
        maxItemsPerAgent: 0,
      },
    })),
    ...agentManagerOverrides,
  };
  const daemonConfigStore = {
    onApply: vi.fn(() => () => {}),
    onChange: vi.fn(() => () => {}),
  };

  const server = new VoiceAssistantWebSocketServer(
    createStub<HTTPServer>({}),
    createStub<pino.Logger>(createLogger()),
    "srv-test",
    createStub<AgentManager>(agentManager),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    "/tmp/paseo-test",
    createStub<DaemonConfigStore>(daemonConfigStore),
    null,
    { allowedOrigins: new Set() },
    createWorkspaceAutoNameStub(),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: vi.fn(),
      scheduleRefreshForCwd: vi.fn(),
      getMetrics: vi.fn(() => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
      })),
      dispose: vi.fn(),
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    pushNotifications,
    createProviderSnapshotManagerStub().manager,
  );

  return { server, agentManager, pushNotifications };
}

function createOpenSocket() {
  return {
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
  };
}

function createSessionWithActivity(
  activity: {
    deviceType: "web" | "mobile";
    deviceClass?: "mobile" | "desktop";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    lastAppActivityAt?: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  subscribed = true,
) {
  const resolved =
    activity === null ? null : { lastAppActivityAt: activity.lastActivityAt, ...activity };
  return {
    getClientActivity: vi.fn(() => resolved),
    supports: () => false,
    supportsForSource: () => false,
    subscribesToAgent: vi.fn(async () => subscribed),
  };
}

function connectClient(
  server: VoiceAssistantWebSocketServer,
  activity: {
    deviceType: "web" | "mobile";
    deviceClass?: "mobile" | "desktop";
    focusedAgentId: string | null;
    lastActivityAt: Date;
    lastAppActivityAt?: Date;
    appVisible: boolean;
    appVisibilityChangedAt?: Date;
  } | null,
  options: { subscribed?: boolean; clientId?: string } = {},
) {
  const ws = createOpenSocket();
  asInternals<WebSocketServerInternals>(server).sessions.set(ws, {
    kind: "trusted",
    session: createSessionWithActivity(activity, options.subscribed ?? true),
    clientId: options.clientId ?? "client-test",
    appVersion: null,
    connectionLogger: createLogger(),
    sockets: new Set([ws]),
    externalDisconnectCleanupTimeout: null,
  });
  return ws;
}

function readAttentionRequiredMessage(ws: ReturnType<typeof createOpenSocket>) {
  const rawMessage = ws.send.mock.calls[0]?.[0];
  expect(typeof rawMessage).toBe("string");
  if (typeof rawMessage !== "string") throw new Error("Expected string WebSocket frame");
  const message = JSON.parse(rawMessage);
  expect(message.type).toBe("session");
  expect(message.message.type).toBe("agent_stream");
  expect(message.message.payload.event.type).toBe("attention_required");
  return message.message.payload.event;
}

describe("VoiceAssistantWebSocketServer notification payloads", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not emit attention or include presence without an agent-directory subscription", async () => {
    const { server, pushNotifications } = createServer();
    const now = new Date();
    const unsubscribed = connectClient(
      server,
      {
        deviceType: "web",
        appVisible: true,
        focusedAgentId: "agent-1",
        lastActivityAt: now,
      },
      { subscribed: false },
    );

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(unsubscribed.send).not.toHaveBeenCalled();
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("uses assistant preview text for push notifications with markdown removed", async () => {
    const getLastAssistantMessage = vi.fn(
      async () => "**Done**. Updated `README.md` and [link](https://example.com).",
    );
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toEqual([
      {
        title: "Agent finished",
        body: "Done. Updated README.md and link.",
        data: {
          serverId: "srv-test",
          workspaceId: WORKSPACE_ID,
          agentId: "agent-1",
          reason: "finished",
        },
      },
    ]);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-1");
  });

  it("still notifies when the assistant message lookup fails", async () => {
    const getLastAssistantMessage = vi.fn(async () => {
      throw new Error("store read failed");
    });
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });
    const client = connectClient(server, {
      deviceType: "web",
      appVisible: true,
      focusedAgentId: null,
      // Stale presence: push fires, and the in-app event still delivers.
      lastActivityAt: new Date(Date.now() - 600_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    // Push falls back to the generic body instead of aborting.
    expect(pushNotifications.sent).toEqual([
      {
        title: "Agent finished",
        body: "Finished working.",
        data: {
          serverId: "srv-test",
          workspaceId: WORKSPACE_ID,
          agentId: "agent-1",
          reason: "finished",
        },
      },
    ]);
    // In-app attention event is still delivered.
    expect(client.send).toHaveBeenCalled();
  });

  it("sends push notifications regardless of UI label presence", async () => {
    const getLastAssistantMessage = vi.fn(async () => "Done.");
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        config: { title: null },
        cwd: "/tmp/worktree",
        workspaceId: WORKSPACE_ID,
        labels: {},
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage,
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-2",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(getLastAssistantMessage).toHaveBeenCalledWith("agent-2");
  });

  it("routes a hidden stale focused browser tab's notification to the present Electron web client", async () => {
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    const electronWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-Y",
      lastActivityAt: new Date(nowMs - 5_000),
    });
    const firefoxWs = connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: "agent-X",
      lastActivityAt: new Date(nowMs - 300_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-X",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(electronWs).shouldNotify).toBe(true);
    expect(readAttentionRequiredMessage(firefoxWs).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("pushes non-error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "finished",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toHaveLength(1);
  });

  it("does not push error attention when the only connected client has never sent a heartbeat", async () => {
    const { server, pushNotifications } = createServer();
    const ws = connectClient(server, null);

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-no-heartbeat",
      provider: "claude",
      reason: "error",
    });

    expect(readAttentionRequiredMessage(ws).shouldNotify).toBe(false);
    expect(pushNotifications.sent).toEqual([]);
  });

  it("pushes to mobile scope when a desktop client is present but the app was not interacted with", async () => {
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    connectClient(server, {
      deviceType: "web",
      appVisible: false,
      focusedAgentId: null,
      // Presence is fresh (OS-idle), but the app window itself is untouched.
      lastActivityAt: new Date(nowMs - 5_000),
      lastAppActivityAt: new Date(nowMs - 600_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(pushNotifications.sentScopes).toEqual(["mobile"]);
  });

  it("pushes mobile scope for permission attention while a desktop client is active", async () => {
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    connectClient(server, {
      deviceType: "web",
      appVisible: true,
      focusedAgentId: "agent-other",
      lastActivityAt: new Date(nowMs - 5_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "permission",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(pushNotifications.sentScopes).toEqual(["mobile"]);
  });

  it("pushes mobile scope for a mobile-origin agent while a desktop client is active", async () => {
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        workspaceId: WORKSPACE_ID,
        config: { title: null },
        labels: { "paseo.origin-device": "mobile" },
        pendingPermissions: new Map(),
      })),
    });
    const nowMs = Date.now();
    connectClient(server, {
      deviceType: "web",
      appVisible: true,
      focusedAgentId: "agent-other",
      lastActivityAt: new Date(nowMs - 5_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(pushNotifications.sentScopes).toEqual(["mobile"]);
  });

  it("pushes mobile scope for a mobile-origin agent when the mobile client views a different agent", async () => {
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        workspaceId: WORKSPACE_ID,
        config: { title: null },
        labels: { "paseo.origin-device": "mobile" },
        pendingPermissions: new Map(),
      })),
    });
    const nowMs = Date.now();
    connectClient(server, {
      deviceType: "web",
      appVisible: true,
      focusedAgentId: "agent-other",
      lastActivityAt: new Date(nowMs - 5_000),
    });
    connectClient(server, {
      deviceType: "mobile",
      appVisible: true,
      focusedAgentId: "agent-other",
      lastActivityAt: new Date(nowMs - 10_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toHaveLength(1);
    expect(pushNotifications.sentScopes).toEqual(["mobile"]);
  });

  it("does not push when a mobile client is actively viewing the target agent", async () => {
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        workspaceId: WORKSPACE_ID,
        config: { title: null },
        labels: { "paseo.origin-device": "mobile" },
        pendingPermissions: new Map(),
      })),
    });
    const nowMs = Date.now();
    connectClient(server, {
      deviceType: "mobile",
      appVisible: true,
      focusedAgentId: "agent-1",
      lastActivityAt: new Date(nowMs - 10_000),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent).toEqual([]);
  });

  it("includes the agent title in the push payload", async () => {
    const { server, pushNotifications } = createServer({
      getAgent: vi.fn(() => ({
        workspaceId: WORKSPACE_ID,
        config: { title: "Refactor auth" },
        labels: {},
        pendingPermissions: new Map(),
      })),
      getLastAssistantMessage: vi.fn(async () => "Done."),
    });

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sent[0]?.body).toBe("Refactor auth: Done.");
    expect(pushNotifications.sent[0]?.data?.agentTitle).toBe("Refactor auth");
  });

  it("suppresses the page-local notification when the mobile web client has push coverage", async () => {
    rmSync(TEST_WEB_PUSH_STORE_PATH, { force: true });
    const { server, pushNotifications } = createServer();
    const webPush = asInternals<WebSocketServerInternals>(server).webPushService;
    expect(webPush).not.toBeNull();
    webPush!.subscribe(
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/pwa-1",
        keys: { auth: generateValidAuth(), p256dh: generateValidP256dh() },
        deviceClass: "mobile",
      },
      "owner",
      "client-pwa",
    );

    const nowMs = Date.now();
    // Mobile web client present and viewing a different agent: it is the
    // in-app recipient AND mobile-scope push reaches its own subscription.
    const pwa = connectClient(
      server,
      {
        deviceType: "web",
        deviceClass: "mobile",
        appVisible: true,
        focusedAgentId: "agent-other",
        lastActivityAt: new Date(nowMs - 5_000),
      },
      { clientId: "client-pwa" },
    );

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sentScopes).toEqual(["mobile"]);
    const event = readAttentionRequiredMessage(pwa);
    // The service worker shows the push — the page must not also fire one.
    expect(event.shouldNotify).toBe(false);
    expect(event.notification).toBeTruthy();
  });

  it("keeps the page-local notification when the mobile web client has no push subscription", async () => {
    rmSync(TEST_WEB_PUSH_STORE_PATH, { force: true });
    const { server, pushNotifications } = createServer();
    const nowMs = Date.now();
    const pwa = connectClient(
      server,
      {
        deviceType: "web",
        deviceClass: "mobile",
        appVisible: true,
        focusedAgentId: "agent-other",
        lastActivityAt: new Date(nowMs - 5_000),
      },
      { clientId: "client-pwa-unsubscribed" },
    );

    await asInternals<WebSocketServerInternals>(server).broadcastAgentAttention({
      agentId: "agent-1",
      provider: "claude",
      reason: "finished",
    });

    expect(pushNotifications.sentScopes).toEqual(["mobile"]);
    const event = readAttentionRequiredMessage(pwa);
    expect(event.shouldNotify).toBe(true);
  });
});
