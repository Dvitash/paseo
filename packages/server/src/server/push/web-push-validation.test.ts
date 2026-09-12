import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_ENDPOINT_LENGTH,
  MAX_KEY_LENGTH,
  validatePushEndpoint,
  validateSubscriptionKeys,
  validateWebPushSubscription,
} from "./web-push-validation.js";

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

describe("Web Push Endpoint Validation (SSRF)", () => {
  it("accepts allowed browser push services with standard HTTPS port", () => {
    const validEndpoints = [
      "https://fcm.googleapis.com/fcm/send/device-token-123",
      "https://p.push.apple.com/send/token-apple-123",
      "https://push.apple.com/send/token-apple-direct",
      "https://web.push.apple.com/send/token-apple-sub",
      "https://updates.push.services.mozilla.com/wpush/v2/mozilla-token",
      "https://push.services.mozilla.com/wpush/v2/direct",
      "https://db5.notify.windows.com/wpush/windows-token",
      "https://notify.windows.com/wpush/direct",
    ];

    for (const endpoint of validEndpoints) {
      const url = validatePushEndpoint(endpoint);
      expect(url.protocol).toBe("https:");
    }
  });

  it("rejects non-HTTPS push endpoints", () => {
    expect(() => validatePushEndpoint("http://fcm.googleapis.com/fcm/send/123")).toThrow(
      /must use HTTPS/,
    );
  });

  it("rejects non-default ports", () => {
    expect(() => validatePushEndpoint("https://fcm.googleapis.com:8443/fcm/send/123")).toThrow(
      /default HTTPS port/,
    );
    expect(() => validatePushEndpoint("https://p.push.apple.com:8080/test")).toThrow(
      /default HTTPS port/,
    );
  });

  it("rejects user credentials", () => {
    expect(() => validatePushEndpoint("https://admin:secret@fcm.googleapis.com/test")).toThrow(
      /must not contain user credentials/,
    );
  });

  it("rejects URL fragments", () => {
    expect(() => validatePushEndpoint("https://fcm.googleapis.com/test#fragment")).toThrow(
      /must not contain URL fragments/,
    );
  });

  it("rejects IP addresses in hostnames", () => {
    const ipEndpoints = [
      "https://127.0.0.1/fcm/send",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/test",
      "https://[fe80::1]/test",
      "https://0x7f000001/test",
    ];

    for (const ip of ipEndpoints) {
      expect(() => validatePushEndpoint(ip)).toThrow(/must not be an IP address/);
    }
  });

  it("rejects disallowed domains and lookalike domains", () => {
    const disallowed = [
      "https://evil.com/push",
      "https://evil-fcm.googleapis.com/push",
      "https://evilpush.apple.com/push",
      "https://fcm.googleapis.com.evil.com/push",
      "https://notify.windows.com.attacker.org/push",
      "https://google.com/test",
    ];

    for (const bad of disallowed) {
      expect(() => validatePushEndpoint(bad)).toThrow(/not an allowed push service/);
    }
  });

  it("rejects endpoints exceeding MAX_ENDPOINT_LENGTH", () => {
    const longEndpoint = "https://fcm.googleapis.com/" + "a".repeat(MAX_ENDPOINT_LENGTH);
    expect(() => validatePushEndpoint(longEndpoint)).toThrow(/exceeds maximum length/);
  });

  it("rejects empty or non-string endpoints", () => {
    expect(() => validatePushEndpoint("")).toThrow(/non-empty string/);
    expect(() => validatePushEndpoint("   ")).toThrow(/non-empty string/);
  });
});

describe("Web Push Subscription Key Validation", () => {
  it("accepts valid auth and p256dh keys", () => {
    const auth = generateValidAuth();
    const p256dh = generateValidP256dh();

    const validated = validateSubscriptionKeys({ auth, p256dh });
    expect(validated.auth).toBe(auth);
    expect(validated.p256dh).toBe(p256dh);
  });

  it("rejects auth keys that do not decode to 16 bytes", () => {
    const p256dh = generateValidP256dh();

    // 15 bytes
    const shortAuth = crypto.randomBytes(15).toString("base64url");
    expect(() => validateSubscriptionKeys({ auth: shortAuth, p256dh })).toThrow(
      /must decode to exactly 16 bytes/,
    );

    // 17 bytes
    const longAuth = crypto.randomBytes(17).toString("base64url");
    expect(() => validateSubscriptionKeys({ auth: longAuth, p256dh })).toThrow(
      /must decode to exactly 16 bytes/,
    );
  });

  it("rejects p256dh keys that do not decode to 65 bytes", () => {
    const auth = generateValidAuth();

    // 64 bytes
    const shortP256 = crypto.randomBytes(64).toString("base64url");
    expect(() => validateSubscriptionKeys({ auth, p256dh: shortP256 })).toThrow(
      /must decode to exactly 65 bytes/,
    );

    // 66 bytes
    const longP256 = crypto.randomBytes(66).toString("base64url");
    expect(() => validateSubscriptionKeys({ auth, p256dh: longP256 })).toThrow(
      /must decode to exactly 65 bytes/,
    );
  });

  it("rejects p256dh keys that do not start with 0x04 uncompressed prefix", () => {
    const auth = generateValidAuth();
    const bytes = crypto.randomBytes(65);
    bytes[0] = 0x02; // compressed format indicator

    expect(() => validateSubscriptionKeys({ auth, p256dh: bytes.toString("base64url") })).toThrow(
      /must start with 0x04/,
    );
  });

  it("rejects p256dh keys where coordinates are not on the P-256 curve", () => {
    const auth = generateValidAuth();
    const valid = Buffer.from(generateValidP256dh(), "base64url");
    // Mutate coordinate to produce an invalid point not lying on the curve
    valid[valid.length - 1]! ^= 0x01;

    expect(() => validateSubscriptionKeys({ auth, p256dh: valid.toString("base64url") })).toThrow(
      /not a valid point on the P-256 curve/,
    );
  });

  it("rejects keys exceeding MAX_KEY_LENGTH", () => {
    const auth = "a".repeat(MAX_KEY_LENGTH + 1);
    const p256dh = generateValidP256dh();
    expect(() => validateSubscriptionKeys({ auth, p256dh })).toThrow(/exceeds maximum length/);
  });

  it("validates full subscription object via validateWebPushSubscription", () => {
    const sub = {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      keys: {
        auth: generateValidAuth(),
        p256dh: generateValidP256dh(),
      },
    };

    const validated = validateWebPushSubscription(sub);
    expect(validated.endpoint).toBe(sub.endpoint);
    expect(validated.keys.auth).toBe(sub.keys.auth);
  });
});
