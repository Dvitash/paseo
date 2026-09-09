import { createECDH } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type pino from "pino";
import webpush from "web-push";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/**
 * Loads existing VAPID keys from disk or generates a new pair.
 *
 * Requirements:
 * - Durable per-daemon keys with private atomic files mode 0600.
 * - Generate once on first run.
 * - Fail on corrupt existing keys rather than silently rotating (silent rotation
 *   breaks all existing browser push subscriptions).
 * - Validates canonical base64url encoding and P-256 public/private key correspondence.
 * - Never logs raw key data or source snippets from JSON parse errors.
 */
function validateVapidKeyBuffers(
  publicKey: string,
  privateKey: string,
  filePath: string,
  vapidLogger: pino.Logger,
): void {
  const pubBuf = Buffer.from(publicKey, "base64url");
  const privBuf = Buffer.from(privateKey, "base64url");

  if (pubBuf.length !== 65 || privBuf.length !== 32) {
    vapidLogger.error("Corrupt VAPID keys file: invalid key encoding or length");
    throw new Error(
      `Corrupt VAPID keys file at ${filePath}: Invalid key length: public=${pubBuf.length} (expected 65), private=${privBuf.length} (expected 32)`,
    );
  }

  if (pubBuf.toString("base64url") !== publicKey || privBuf.toString("base64url") !== privateKey) {
    vapidLogger.error("Corrupt VAPID keys file: invalid key encoding or length");
    throw new Error(
      `Corrupt VAPID keys file at ${filePath}: VAPID keys must use canonical base64url encoding without padding`,
    );
  }

  let derivedPublicKey: Buffer;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(privBuf);
    derivedPublicKey = ecdh.getPublicKey();
  } catch {
    vapidLogger.error("Corrupt VAPID keys file: public and private key mismatch");
    throw new Error(`Corrupt VAPID keys file at ${filePath}: Invalid P-256 private key`);
  }

  if (!derivedPublicKey.equals(pubBuf)) {
    vapidLogger.error("Corrupt VAPID keys file: public and private key mismatch");
    throw new Error(
      `Corrupt VAPID keys file at ${filePath}: VAPID public and private keys do not correspond to the same P-256 keypair`,
    );
  }
}

function loadAndValidateExistingVapidKeys(filePath: string, vapidLogger: pino.Logger): VapidKeys {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    vapidLogger.error("Failed to read existing VAPID keys file");
    throw new Error(`Failed to read existing VAPID keys file at ${filePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never log raw parseError object as it may contain source snippets with keys
    vapidLogger.error("Corrupt VAPID keys file: invalid JSON");
    throw new Error(`Corrupt VAPID keys file at ${filePath}: invalid JSON`);
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("publicKey" in parsed) ||
    !("privateKey" in parsed)
  ) {
    vapidLogger.error("Corrupt VAPID keys file: expected object with publicKey and privateKey");
    throw new Error(
      `Corrupt VAPID keys file at ${filePath}: expected object with publicKey and privateKey`,
    );
  }

  const { publicKey: rawPublicKey, privateKey: rawPrivateKey } = parsed as {
    publicKey: unknown;
    privateKey: unknown;
  };

  if (
    typeof rawPublicKey !== "string" ||
    rawPublicKey.trim().length === 0 ||
    typeof rawPrivateKey !== "string" ||
    rawPrivateKey.trim().length === 0
  ) {
    vapidLogger.error("Corrupt VAPID keys file: missing or empty publicKey/privateKey");
    throw new Error(
      `Corrupt VAPID keys file at ${filePath}: missing or empty publicKey/privateKey`,
    );
  }

  const publicKey = rawPublicKey.trim();
  const privateKey = rawPrivateKey.trim();

  validateVapidKeyBuffers(publicKey, privateKey, filePath, vapidLogger);

  return { publicKey, privateKey };
}

export function loadOrCreateVapidKeys(
  filePath: string,
  logger: pino.Logger,
  write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
): VapidKeys {
  const vapidLogger = logger.child({ component: "vapid-keys" });

  if (existsSync(filePath)) {
    ensurePrivateFile(filePath);
    const keys = loadAndValidateExistingVapidKeys(filePath, vapidLogger);
    vapidLogger.debug("Loaded existing VAPID keys");
    return keys;
  }

  vapidLogger.info("Generating new per-daemon VAPID keys");
  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };

  const payload = JSON.stringify(keys, null, 2) + "\n";
  write(filePath, payload);
  ensurePrivateFile(filePath);

  vapidLogger.info("Persisted new VAPID keys with private file permissions");
  return keys;
}
