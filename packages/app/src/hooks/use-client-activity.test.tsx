/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { HeartbeatPayload } from "./client-activity-tracker";

const START_MS = new Date("2026-09-10T10:00:00.000Z").getTime();
// Matches PRESENCE_THRESHOLD_MS on the server.
const PRESENCE_THRESHOLD_MS = 180_000;

interface FakeClient {
  isConnected: boolean;
  heartbeats: HeartbeatPayload[];
  sendHeartbeat(payload: HeartbeatPayload): void;
  subscribeConnectionStatus(cb: (state: { status: string }) => void): () => void;
}

function createFakeClient(): FakeClient {
  return {
    isConnected: true,
    heartbeats: [],
    sendHeartbeat(payload) {
      this.heartbeats.push(payload);
    },
    subscribeConnectionStatus(cb) {
      cb({ status: "connected" });
      return () => {};
    },
  };
}

async function loadHook(platform: "web" | "ios") {
  vi.resetModules();
  vi.doMock("react-native", () => ({
    Platform: { OS: platform },
    AppState: {
      currentState: "active",
      addEventListener: vi.fn(() => ({ remove: () => {} })),
    },
  }));
  vi.doMock("@/desktop/host", () => ({
    getDesktopHost: () => null,
    isElectronRuntime: () => false,
    isElectronRuntimeMac: () => false,
  }));
  const hook = await import("./use-client-activity");
  const source = await import("./native-activity-source");
  return {
    useClientActivity: hook.useClientActivity,
    notifyNativeUserActivity: source.notifyNativeUserActivity,
  };
}

describe("useClientActivity", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("react-native");
    vi.doUnmock("@/desktop/host");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("refreshes both activity clocks from native touch past the presence threshold", async () => {
    const { useClientActivity, notifyNativeUserActivity } = await loadHook("ios");
    const client = createFakeClient();

    renderHook(() =>
      useClientActivity({ client: client as never, focusedAgentId: null, focusedTerminalId: null }),
    );

    // Initial heartbeat from the connection-status subscription.
    expect(client.heartbeats.length).toBeGreaterThan(0);
    client.heartbeats.length = 0;

    // Stay on the same screen past the presence threshold, then touch.
    vi.setSystemTime(START_MS + PRESENCE_THRESHOLD_MS + 60_000);
    notifyNativeUserActivity();

    expect(client.heartbeats.length).toBeGreaterThan(0);
    const heartbeat = client.heartbeats.at(-1)!;
    expect(heartbeat.deviceClass).toBe("mobile");
    // Both clocks advanced to now — the client must not look absent.
    expect(new Date(heartbeat.lastActivityAt).getTime()).toBe(Date.now());
    expect(new Date(heartbeat.lastAppActivityAt).getTime()).toBe(Date.now());
    expect(heartbeat.appVisible).toBe(true);
  });

  it("sends an unthrottled heartbeat with appVisible=false immediately on web hide", async () => {
    const { useClientActivity } = await loadHook("web");
    const client = createFakeClient();

    renderHook(() =>
      useClientActivity({ client: client as never, focusedAgentId: null, focusedTerminalId: null }),
    );
    client.heartbeats.length = 0;

    // Hide the tab — heartbeat must fire immediately, not after the interval.
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(client.heartbeats.length).toBe(1);
    expect(client.heartbeats[0]!.appVisible).toBe(false);
  });

  it("reports appVisible=false when the window loses focus while still visible", async () => {
    const { useClientActivity } = await loadHook("web");
    const client = createFakeClient();

    renderHook(() =>
      useClientActivity({ client: client as never, focusedAgentId: null, focusedTerminalId: null }),
    );
    client.heartbeats.length = 0;

    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));

    expect(client.heartbeats.length).toBe(1);
    expect(client.heartbeats[0]!.appVisible).toBe(false);
  });
});
