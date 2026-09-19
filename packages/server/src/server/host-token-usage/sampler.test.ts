import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostTokenUsageSampler } from "./sampler.js";
import {
  createHostTokenUsageReader,
  parseRangesFromOmpStdout,
  queryRangesFromSqlite,
} from "./reader.js";

describe("HostTokenUsageSampler", () => {
  it("caches snapshot within TTL and invalidates on force", async () => {
    let now = 1_000_000;
    let callCount = 0;
    const sampler = new HostTokenUsageSampler({
      now: () => now,
      read: async () => {
        callCount += 1;
        return {
          status: "available",
          ranges: {
            "1h": { inputTokens: 100 * callCount, cacheReadTokens: 0, outputTokens: 0 },
            "24h": { inputTokens: 200 * callCount, cacheReadTokens: 0, outputTokens: 0 },
            "7d": { inputTokens: 300 * callCount, cacheReadTokens: 0, outputTokens: 0 },
            "30d": { inputTokens: 400 * callCount, cacheReadTokens: 0, outputTokens: 0 },
            all: { inputTokens: 500 * callCount, cacheReadTokens: 0, outputTokens: 0 },
          },
        };
      },
    });

    const first = await sampler.getSnapshot();
    expect(first.status).toBe("available");
    expect(first.ranges?.["1h"].inputTokens).toBe(100);
    expect(callCount).toBe(1);

    // Call within TTL returns cached result
    now += 10_000;
    const cached = await sampler.getSnapshot();
    expect(cached.ranges?.["1h"].inputTokens).toBe(100);
    expect(callCount).toBe(1);

    // Force bypasses cache
    const forced = await sampler.getSnapshot(true);
    expect(forced.ranges?.["1h"].inputTokens).toBe(200);
    expect(callCount).toBe(2);

    // After TTL expires, fetches fresh
    now += 70_000;
    const expired = await sampler.getSnapshot();
    expect(expired.ranges?.["1h"].inputTokens).toBe(300);
    expect(callCount).toBe(3);
  });

  it("handles reader errors gracefully", async () => {
    const sampler = new HostTokenUsageSampler({
      read: async () => {
        throw new Error("Command failed");
      },
    });

    const snapshot = await sampler.getSnapshot();
    expect(snapshot.status).toBe("unavailable");
    expect(snapshot.ranges).toBeNull();
    expect(snapshot.error).toBe("Command failed");
  });

  it("parses ranges from omp stats stdout", () => {
    const stdout = `Syncing session files...
Synced 10 new entries

{
  "overall": {
    "totalInputTokens": 1000,
    "totalCacheReadTokens": 5000,
    "totalOutputTokens": 200
  }
}`;
    const ranges = parseRangesFromOmpStdout(stdout);
    expect(ranges).not.toBeNull();
    expect(ranges?.["24h"]).toEqual({
      inputTokens: 1000,
      cacheReadTokens: 5000,
      outputTokens: 200,
    });
    expect(ranges?.["1h"]).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    });
    expect(ranges?.["all"]).toEqual({
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    });
  });

  it("falls back to the local stats database when omp stats fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-stats-fallback-test-"));
    const dbPath = join(tempDir, "stats.db");
    try {
      const sqliteSpecifier: string = "node:sqlite";
      const { DatabaseSync } = (await import(sqliteSpecifier)) as {
        DatabaseSync: new (path: string) => {
          exec: (sql: string) => void;
          close: () => void;
        };
      };
      const db = new DatabaseSync(dbPath);
      const now = Date.now();
      db.exec(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL
        );
        INSERT INTO messages VALUES (1, ${now - 30_000}, 123, 456, 78);
      `);
      db.close();

      const read = createHostTokenUsageReader({
        dbPath,
        executablePath: join(tempDir, "missing-omp"),
      });
      const reading = await read();

      expect(reading.status).toBe("available");
      expect(reading.error).toBeUndefined();
      expect(reading.ranges?.["1h"]).toEqual({
        inputTokens: 123,
        cacheReadTokens: 456,
        outputTokens: 78,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("queries ranges from sqlite database", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "paseo-stats-test-"));
    const dbPath = join(tempDir, "stats.db");
    try {
      const sqliteSpecifier: string = "node:sqlite";
      const { DatabaseSync } = (await import(sqliteSpecifier)) as {
        DatabaseSync: new (path: string) => {
          exec: (sql: string) => void;
          close: () => void;
        };
      };
      const db = new DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          timestamp INTEGER NOT NULL,
          input_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL
        );
      `);
      const now = 10_000_000_000;
      // Insert one 30 min ago (within 1h)
      db.exec(`INSERT INTO messages VALUES (1, ${now - 1800 * 1000}, 100, 200, 50);`);
      // Insert one 2 hours ago (within 24h, not 1h)
      db.exec(`INSERT INTO messages VALUES (2, ${now - 7200 * 1000}, 1000, 2000, 500);`);
      db.close();

      const ranges = await queryRangesFromSqlite(dbPath, now);
      expect(ranges).not.toBeNull();
      expect(ranges?.["1h"]).toEqual({ inputTokens: 100, cacheReadTokens: 200, outputTokens: 50 });
      expect(ranges?.["24h"]).toEqual({
        inputTokens: 1100,
        cacheReadTokens: 2200,
        outputTokens: 550,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
