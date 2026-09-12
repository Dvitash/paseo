import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PRIVATE_FILE_MODE } from "../private-files.js";
import { loadOrCreateVapidKeys } from "./vapid-keys.js";

const MODE_MASK = 0o777;

function createNoopLogger(): pino.Logger {
  return pino({ level: "silent" });
}

describe("loadOrCreateVapidKeys", () => {
  let tempDir: string;
  let keyPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "vapid-test-"));
    keyPath = path.join(tempDir, "vapid-keys.json");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("generates new VAPID keys when file does not exist and sets mode 0600", () => {
    const logger = createNoopLogger();
    expect(existsSync(keyPath)).toBe(false);

    const keys = loadOrCreateVapidKeys(keyPath, logger);

    expect(keys.publicKey).toBeDefined();
    expect(keys.privateKey).toBeDefined();
    expect(keys.publicKey.length).toBeGreaterThan(50);
    expect(keys.privateKey.length).toBeGreaterThan(30);

    expect(existsSync(keyPath)).toBe(true);
    if (process.platform !== "win32") {
      const mode = statSync(keyPath).mode & MODE_MASK;
      expect(mode).toBe(PRIVATE_FILE_MODE);
    }

    const saved = JSON.parse(readFileSync(keyPath, "utf8"));
    expect(saved).toEqual({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    });
  });

  it("loads existing valid VAPID keys from disk without generating new ones", () => {
    const logger = createNoopLogger();
    const first = loadOrCreateVapidKeys(keyPath, logger);
    const second = loadOrCreateVapidKeys(keyPath, logger);

    expect(second).toEqual(first);
  });

  it("fails fast on corrupted JSON without silently rotating keys", () => {
    const logger = createNoopLogger();
    writeFileSync(keyPath, "{ invalid json ...", "utf8");

    expect(() => loadOrCreateVapidKeys(keyPath, logger)).toThrow(
      /Corrupt VAPID keys file at.*invalid JSON/,
    );
    // Ensure it did not overwrite the corrupt file with new keys
    expect(readFileSync(keyPath, "utf8")).toBe("{ invalid json ...");
  });

  it("fails fast when publicKey or privateKey is missing", () => {
    const logger = createNoopLogger();
    writeFileSync(keyPath, JSON.stringify({ publicKey: "foo" }), "utf8");

    expect(() => loadOrCreateVapidKeys(keyPath, logger)).toThrow(
      /expected object with publicKey and privateKey/,
    );
  });

  it("fails fast when publicKey or privateKey is empty", () => {
    const logger = createNoopLogger();
    writeFileSync(keyPath, JSON.stringify({ publicKey: "foo", privateKey: "  " }), "utf8");

    expect(() => loadOrCreateVapidKeys(keyPath, logger)).toThrow(
      /missing or empty publicKey\/privateKey/,
    );
  });

  it("fails fast when key byte lengths are invalid", () => {
    const logger = createNoopLogger();
    writeFileSync(
      keyPath,
      JSON.stringify({
        publicKey: Buffer.from("short").toString("base64url"),
        privateKey: Buffer.from("short-priv").toString("base64url"),
      }),
      "utf8",
    );

    expect(() => loadOrCreateVapidKeys(keyPath, logger)).toThrow(/Invalid key length/);
  });

  it("fails fast when public and private keys do not correspond to the same P-256 keypair", () => {
    const logger = createNoopLogger();
    // Generate two different valid key pairs
    const pair1 = loadOrCreateVapidKeys(path.join(tempDir, "keys1.json"), logger);
    const pair2 = loadOrCreateVapidKeys(path.join(tempDir, "keys2.json"), logger);

    // Write mismatched pair (public from pair1, private from pair2)
    writeFileSync(
      keyPath,
      JSON.stringify({
        publicKey: pair1.publicKey,
        privateKey: pair2.privateKey,
      }),
      "utf8",
    );

    expect(() => loadOrCreateVapidKeys(keyPath, logger)).toThrow(
      /public and private keys do not correspond to the same P-256 keypair/,
    );
  });

  it("fails fast when keys use non-canonical base64url padding", () => {
    const logger = createNoopLogger();
    const validPair = loadOrCreateVapidKeys(path.join(tempDir, "keys1.json"), logger);

    // Pad with =
    writeFileSync(
      keyPath,
      JSON.stringify({
        publicKey: validPair.publicKey + "=",
        privateKey: validPair.privateKey,
      }),
      "utf8",
    );

    expect(() => loadOrCreateVapidKeys(keyPath, logger)).toThrow(
      /canonical base64url encoding without padding/,
    );
  });
});
