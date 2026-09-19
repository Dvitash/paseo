import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HostTokenUsageRanges } from "@getpaseo/protocol/host-token-usage";
import { execCommand } from "../../utils/spawn.js";

export interface HostTokenUsageReading {
  status: "available" | "unavailable";
  ranges?: HostTokenUsageRanges;
  error?: string | null;
}

interface SqliteStatement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

const ZERO_RANGE = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 };

export async function queryRangesFromSqlite(
  dbPath: string,
  now = Date.now(),
): Promise<HostTokenUsageRanges | null> {
  // Held in a variable so TypeScript skips module resolution: @types/node@20 has no
  // node:sqlite typings yet, while the runtime (Node 22+ / Electron) provides it.
  const sqliteSpecifier: string = "node:sqlite";
  let sqlite: NodeSqliteModule;
  try {
    sqlite = (await import(sqliteSpecifier)) as unknown as NodeSqliteModule;
  } catch {
    return null;
  }

  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const stmt = db.prepare(`
      SELECT
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(cache_read_tokens), 0) as cacheReadTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens
      FROM messages
      WHERE timestamp >= ?
    `);

    const getRange = (cutoff: number) => {
      const row = stmt.get(cutoff);
      return {
        inputTokens: Math.max(0, Number(row?.inputTokens ?? 0)),
        cacheReadTokens: Math.max(0, Number(row?.cacheReadTokens ?? 0)),
        outputTokens: Math.max(0, Number(row?.outputTokens ?? 0)),
      };
    };

    return {
      "1h": getRange(now - 3600 * 1000),
      "24h": getRange(now - 24 * 3600 * 1000),
      "7d": getRange(now - 7 * 24 * 3600 * 1000),
      "30d": getRange(now - 30 * 24 * 3600 * 1000),
      all: getRange(0),
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors
    }
  }
}

export function parseRangesFromOmpStdout(stdout: string): HostTokenUsageRanges | null {
  const jsonStart = stdout.indexOf("{");
  if (jsonStart === -1) return null;
  try {
    const data = JSON.parse(stdout.slice(jsonStart));
    const overall = data?.overall;
    if (!overall) return null;
    // OMP stats --json defaults to 24-hour window; do not fabricate data for other ranges
    const range24h = {
      inputTokens: Math.max(0, Number(overall.totalInputTokens ?? 0)),
      cacheReadTokens: Math.max(0, Number(overall.totalCacheReadTokens ?? 0)),
      outputTokens: Math.max(0, Number(overall.totalOutputTokens ?? 0)),
    };
    return {
      "1h": ZERO_RANGE,
      "24h": range24h,
      "7d": ZERO_RANGE,
      "30d": ZERO_RANGE,
      all: ZERO_RANGE,
    };
  } catch {
    return null;
  }
}

export function createHostTokenUsageReader(options?: {
  executablePath?: string;
  dbPath?: string;
}): () => Promise<HostTokenUsageReading> {
  const envCmd = process.env.OMP_COMMAND?.trim();
  const localBin = join(homedir(), ".local", "bin", "omp");
  const command = options?.executablePath ?? envCmd ?? (existsSync(localBin) ? localBin : "omp");
  const dbPath = options?.dbPath ?? join(homedir(), ".omp", "stats.db");

  return async function readHostTokenUsage(): Promise<HostTokenUsageReading> {
    try {
      const result = await execCommand(command, ["stats", "--json"], {
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      // 1. First try direct sqlite read from synced DB for exact distinct ranges
      if (existsSync(dbPath)) {
        const sqliteRanges = await queryRangesFromSqlite(dbPath);
        if (sqliteRanges) {
          return { status: "available", ranges: sqliteRanges };
        }
      }

      // 2. Fallback to parsing stdout (OMP overall is 24h window)
      const stdoutRanges = parseRangesFromOmpStdout(result.stdout);
      if (stdoutRanges) {
        return { status: "available", ranges: stdoutRanges };
      }

      // 3. Fallback to zeroes if successful command but empty output
      return {
        status: "available",
        ranges: {
          "1h": ZERO_RANGE,
          "24h": ZERO_RANGE,
          "7d": ZERO_RANGE,
          "30d": ZERO_RANGE,
          all: ZERO_RANGE,
        },
      };
    } catch (error) {
      // OMP's compiled stats command can fail after or during session sync. If the
      // local stats database is readable, keep token usage available instead of
      // surfacing the CLI failure to the client.
      if (existsSync(dbPath)) {
        const sqliteRanges = await queryRangesFromSqlite(dbPath);
        if (sqliteRanges) {
          return { status: "available", ranges: sqliteRanges };
        }
      }

      const isMissingCommand =
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOENT" || error.code === 127);
      if (isMissingCommand) {
        return { status: "unavailable", error: "omp command not found on this host" };
      }
      return {
        status: "unavailable",
        error: error instanceof Error ? error.message : "Failed to execute omp stats",
      };
    }
  };
}
