import { describe, expect, it } from "vitest";
import { DaemonClient } from "./daemon-client.js";
import type { DaemonClientTransport } from "./daemon-client-transport-types.js";

function createMockTransport() {
  const sent: Array<string | Uint8Array | ArrayBuffer> = [];
  const closeCalls: Array<{ code?: number; reason?: string }> = [];

  let onMessage: (data: unknown) => void = () => {};
  let onOpen: () => void = () => {};

  const transport: DaemonClientTransport = {
    send: (data) => {
      sent.push(data);
    },
    close: (code?: number, reason?: string) => {
      closeCalls.push({ code, reason });
    },
    onMessage: (handler) => {
      onMessage = handler;
      return () => {};
    },
    onOpen: (handler) => {
      onOpen = handler;
      return () => {};
    },
    onClose: (_handler) => {
      return () => {};
    },
    onError: (_handler) => {
      return () => {};
    },
  };

  return {
    transport,
    sent,
    closeCalls,
    triggerOpen: (options?: { preserveSent?: boolean; features?: Record<string, boolean> }) => {
      onOpen();
      if (!options?.preserveSent) {
        sent.length = 0;
      }
      onMessage(
        JSON.stringify({
          type: "session",
          message: {
            type: "status",
            payload: {
              status: "server_info",
              serverId: "test-daemon",
              version: "1.0.0",
              hostname: "test-daemon",
              features: { webPush: true, ...options?.features },
            },
          },
        }),
      );
    },
    emitMessage: (msg: unknown) => {
      onMessage(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  };
}

describe("DaemonClient Web Push methods", () => {
  it("sends push.web.get_config.request and returns public key", async () => {
    const mock = createMockTransport();
    const client = new DaemonClient({
      url: "ws://test",
      clientId: "test-client",
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const configPromise = client.getWebPushConfig("cfg-req-1");

    // Check sent frame
    const lastSent = JSON.parse(String(mock.sent[mock.sent.length - 1]));
    expect(lastSent).toEqual({
      type: "session",
      message: {
        type: "push.web.get_config.request",
        requestId: "cfg-req-1",
      },
    });

    // Simulate response
    mock.emitMessage({
      type: "session",
      message: {
        type: "push.web.get_config.response",
        payload: {
          requestId: "cfg-req-1",
          publicKey: "BMc3Jld-test-key",
        },
      },
    });

    const res = await configPromise;
    expect(res).toEqual({ publicKey: "BMc3Jld-test-key" });
    await client.close();
  });

  it("sends push.web.subscribe.request with subscription payload", async () => {
    const mock = createMockTransport();
    const client = new DaemonClient({
      url: "ws://test",
      clientId: "test-client",
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const sub = {
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/test-1",
      keys: {
        p256dh: "BMc3Jld-p256dh",
        auth: "auth-16bytes-1234",
      },
    };

    const subscribePromise = client.subscribeWebPush(sub, "sub-req-1");

    const lastSent = JSON.parse(String(mock.sent[mock.sent.length - 1]));
    expect(lastSent).toEqual({
      type: "session",
      message: {
        type: "push.web.subscribe.request",
        requestId: "sub-req-1",
        subscription: sub,
      },
    });

    mock.emitMessage({
      type: "session",
      message: {
        type: "push.web.subscribe.response",
        payload: {
          requestId: "sub-req-1",
        },
      },
    });

    await subscribePromise;
    await client.close();
  });

  it("sends push.web.unsubscribe.request with endpoint", async () => {
    const mock = createMockTransport();
    const client = new DaemonClient({
      url: "ws://test",
      clientId: "test-client",
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const unsubPromise = client.unsubscribeWebPush(
      "https://updates.push.services.mozilla.com/wpush/v2/test-1",
      "unsub-req-1",
    );

    const lastSent = JSON.parse(String(mock.sent[mock.sent.length - 1]));
    expect(lastSent).toEqual({
      type: "session",
      message: {
        type: "push.web.unsubscribe.request",
        requestId: "unsub-req-1",
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/test-1",
      },
    });

    mock.emitMessage({
      type: "session",
      message: {
        type: "push.web.unsubscribe.response",
        payload: {
          requestId: "unsub-req-1",
        },
      },
    });

    await unsubPromise;
    await client.close();
  });

  it("sends push.web.test.request with endpoint", async () => {
    const mock = createMockTransport();
    const client = new DaemonClient({
      url: "ws://test",
      clientId: "test-client",
      reconnect: { enabled: false },
      transportFactory: () => mock.transport,
    });

    const connectPromise = client.connect();
    mock.triggerOpen();
    await connectPromise;

    const testPromise = client.testWebPush(
      "https://updates.push.services.mozilla.com/wpush/v2/test-1",
      "test-req-1",
    );

    const lastSent = JSON.parse(String(mock.sent[mock.sent.length - 1]));
    expect(lastSent).toEqual({
      type: "session",
      message: {
        type: "push.web.test.request",
        requestId: "test-req-1",
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/test-1",
      },
    });

    mock.emitMessage({
      type: "session",
      message: {
        type: "push.web.test.response",
        payload: {
          requestId: "test-req-1",
        },
      },
    });

    await testPromise;
    await client.close();
  });
});
