import { describe, expect, it } from "vitest";
import {
  PushWebGetConfigRequestSchema,
  PushWebGetConfigResponseSchema,
  PushWebSubscribeRequestSchema,
  PushWebSubscribeResponseSchema,
  PushWebUnsubscribeRequestSchema,
  PushWebUnsubscribeResponseSchema,
  PushWebTestRequestSchema,
  PushWebTestResponseSchema,
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  WebPushSubscriptionSchema,
} from "./messages.js";

describe("Web Push protocol messages", () => {
  it("parses valid WebPushSubscription", () => {
    const valid = {
      endpoint: "https://fcm.googleapis.com/fcm/send/sample-token",
      keys: {
        p256dh:
          "BMc3Jld--fJwU7rl4lOuGDsJedj___bXFuNY20EfKAAdcHXZKG26FrYDl-wgLot8j3FUDz-zSBRe1cXKB9hz6A",
        auth: "1234567890123456",
      },
      expirationTime: null,
    };
    const parsed = WebPushSubscriptionSchema.parse(valid);
    expect(parsed.endpoint).toBe(valid.endpoint);
    expect(parsed.keys.p256dh).toBe(valid.keys.p256dh);
    expect(parsed.keys.auth).toBe(valid.keys.auth);
    expect(parsed.expirationTime).toBeNull();
  });

  it("parses push.web.get_config request and response", () => {
    const req = PushWebGetConfigRequestSchema.parse({
      type: "push.web.get_config.request",
      requestId: "req-1",
    });
    expect(req.requestId).toBe("req-1");

    const res = PushWebGetConfigResponseSchema.parse({
      type: "push.web.get_config.response",
      payload: {
        requestId: "req-1",
        publicKey: "BBMc3Jld...",
      },
    });
    expect(res.payload.publicKey).toBe("BBMc3Jld...");

    expect(SessionInboundMessageSchema.parse(req)).toEqual(req);
    expect(SessionOutboundMessageSchema.parse(res)).toEqual(res);
  });

  it("parses push.web.subscribe request and response", () => {
    const req = PushWebSubscribeRequestSchema.parse({
      type: "push.web.subscribe.request",
      requestId: "req-sub-1",
      subscription: {
        endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc",
        keys: {
          p256dh: "p256dh-key",
          auth: "auth-key",
        },
      },
    });
    expect(req.subscription.endpoint).toBe(
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
    );

    const res = PushWebSubscribeResponseSchema.parse({
      type: "push.web.subscribe.response",
      payload: { requestId: "req-sub-1" },
    });
    expect(res.payload.requestId).toBe("req-sub-1");

    expect(SessionInboundMessageSchema.parse(req)).toEqual(req);
    expect(SessionOutboundMessageSchema.parse(res)).toEqual(res);
  });

  it("parses push.web.unsubscribe request and response", () => {
    const req = PushWebUnsubscribeRequestSchema.parse({
      type: "push.web.unsubscribe.request",
      requestId: "req-unsub-1",
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc",
    });
    expect(req.endpoint).toBe("https://updates.push.services.mozilla.com/wpush/v2/abc");

    const res = PushWebUnsubscribeResponseSchema.parse({
      type: "push.web.unsubscribe.response",
      payload: { requestId: "req-unsub-1" },
    });
    expect(res.payload.requestId).toBe("req-unsub-1");

    expect(SessionInboundMessageSchema.parse(req)).toEqual(req);
    expect(SessionOutboundMessageSchema.parse(res)).toEqual(res);
  });

  it("parses push.web.test request and response", () => {
    const req = PushWebTestRequestSchema.parse({
      type: "push.web.test.request",
      requestId: "req-test-1",
      endpoint: "https://updates.push.services.mozilla.com/wpush/v2/abc",
    });
    expect(req.endpoint).toBe("https://updates.push.services.mozilla.com/wpush/v2/abc");

    const res = PushWebTestResponseSchema.parse({
      type: "push.web.test.response",
      payload: { requestId: "req-test-1" },
    });
    expect(res.payload.requestId).toBe("req-test-1");

    expect(SessionInboundMessageSchema.parse(req)).toEqual(req);
    expect(SessionOutboundMessageSchema.parse(res)).toEqual(res);
  });

  it("allows optional webPush feature on ServerInfoStatusPayloadSchema", () => {
    const legacy = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-legacy",
      features: {},
    });
    expect(legacy.features?.webPush).toBeUndefined();

    const withWebPush = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv-new",
      features: {
        webPush: true,
      },
    });
    expect(withWebPush.features?.webPush).toBe(true);
  });
});
