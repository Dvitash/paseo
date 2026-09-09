import crypto from "node:crypto";
import type { WebPushSubscription, WebPushSubscriptionKeys } from "@getpaseo/protocol/messages";

export const MAX_ENDPOINT_LENGTH = 2048;
export const MAX_KEY_LENGTH = 256;

/**
 * Validates a web push service endpoint against SSRF attacks.
 *
 * Rules:
 * - HTTPS protocol required.
 * - Standard default port (443 or omitted) required.
 * - No credentials (username/password) allowed.
 * - No fragment allowed.
 * - No IP address hostnames (IPv4, IPv6, octal, hex) allowed.
 * - Allowed domains:
 *   - fcm.googleapis.com
 *   - push.apple.com and *.push.apple.com
 *   - updates.push.services.mozilla.com and *.push.services.mozilla.com
 *   - notify.windows.com and *.notify.windows.com
 */
function isTrustedPushHostname(hostname: string): boolean {
  if (hostname === "fcm.googleapis.com") {
    return true;
  }
  if (hostname === "push.apple.com" || hostname.endsWith(".push.apple.com")) {
    return true;
  }
  if (
    hostname === "push.services.mozilla.com" ||
    hostname === "updates.push.services.mozilla.com" ||
    hostname.endsWith(".push.services.mozilla.com")
  ) {
    return true;
  }
  if (hostname === "notify.windows.com" || hostname.endsWith(".notify.windows.com")) {
    return true;
  }
  return false;
}

export function validatePushEndpoint(endpoint: string): URL {
  if (typeof endpoint !== "string" || endpoint.trim().length === 0) {
    throw new Error("Push endpoint must be a non-empty string");
  }

  const trimmed = endpoint.trim();
  if (trimmed.length > MAX_ENDPOINT_LENGTH) {
    throw new Error(`Push endpoint exceeds maximum length of ${MAX_ENDPOINT_LENGTH} characters`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Push endpoint must be a valid URL");
  }

  if (parsed.protocol !== "https:") {
    throw new Error(`Push endpoint must use HTTPS (received: ${parsed.protocol})`);
  }

  if (parsed.port !== "" && parsed.port !== "443") {
    throw new Error(`Push endpoint must use default HTTPS port (received port: ${parsed.port})`);
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("Push endpoint must not contain user credentials");
  }

  if (parsed.hash !== "") {
    throw new Error("Push endpoint must not contain URL fragments");
  }

  const hostname = parsed.hostname.toLowerCase();

  // Reject IP addresses (IPv4 decimal/octal/hex, IPv6 brackets or colons)
  if (
    /^[\d.]+$|^\[.*\]$/.test(hostname) ||
    hostname.includes(":") ||
    /^0x[0-9a-f]+$/i.test(hostname)
  ) {
    throw new Error("Push endpoint hostname must not be an IP address");
  }

  if (!isTrustedPushHostname(hostname)) {
    throw new Error(`Push endpoint hostname '${hostname}' is not an allowed push service`);
  }

  return parsed;
}

/**
 * Validates web push subscription client keys (p256dh and auth).
 *
 * Requirements:
 * - auth: base64url decoded to exactly 16 bytes.
 * - p256dh: base64url decoded to exactly 65 bytes, starts with 0x04 (uncompressed point),
 *   and represents a cryptographically valid point on the P-256 (prime256v1) elliptic curve.
 */
export function validateSubscriptionKeys(keys: WebPushSubscriptionKeys): WebPushSubscriptionKeys {
  if (!keys || typeof keys !== "object") {
    throw new Error("Subscription keys must be an object");
  }

  if (typeof keys.auth !== "string" || keys.auth.trim().length === 0) {
    throw new Error("Subscription auth key must be a non-empty string");
  }

  if (typeof keys.p256dh !== "string" || keys.p256dh.trim().length === 0) {
    throw new Error("Subscription p256dh key must be a non-empty string");
  }

  const auth = keys.auth.trim();
  const p256dh = keys.p256dh.trim();

  if (auth.length > MAX_KEY_LENGTH) {
    throw new Error(`Subscription auth key exceeds maximum length of ${MAX_KEY_LENGTH}`);
  }

  if (p256dh.length > MAX_KEY_LENGTH) {
    throw new Error(`Subscription p256dh key exceeds maximum length of ${MAX_KEY_LENGTH}`);
  }

  const authBuf = Buffer.from(auth, "base64url");
  if (authBuf.length !== 16) {
    throw new Error(
      `Subscription auth key must decode to exactly 16 bytes (received ${authBuf.length})`,
    );
  }

  const p256dhBuf = Buffer.from(p256dh, "base64url");
  if (p256dhBuf.length !== 65) {
    throw new Error(
      `Subscription p256dh key must decode to exactly 65 bytes (received ${p256dhBuf.length})`,
    );
  }

  if (p256dhBuf[0] !== 0x04) {
    throw new Error("Subscription p256dh key must start with 0x04 uncompressed point format");
  }

  const x = p256dhBuf.subarray(1, 33).toString("base64url");
  const y = p256dhBuf.subarray(33, 65).toString("base64url");

  try {
    crypto.createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x,
        y,
      },
      format: "jwk",
    });
  } catch {
    throw new Error("Subscription p256dh key is not a valid point on the P-256 curve");
  }

  return { p256dh, auth };
}

/**
 * Validates a complete WebPushSubscription object before registration.
 */
export function validateWebPushSubscription(subscription: WebPushSubscription): {
  endpoint: string;
  keys: WebPushSubscriptionKeys;
  expirationTime?: number | null;
} {
  if (!subscription || typeof subscription !== "object") {
    throw new Error("Subscription must be an object");
  }

  validatePushEndpoint(subscription.endpoint);
  const validatedKeys = validateSubscriptionKeys(subscription.keys);

  return {
    endpoint: subscription.endpoint.trim(),
    keys: validatedKeys,
    expirationTime: subscription.expirationTime ?? null,
  };
}
