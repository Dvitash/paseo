import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_WEIGHTS,
  formatProviderDisplayName,
  loadAccountWeights,
  readOmpUsage,
  type AccountWeightsConfig,
  type OmpUsageData,
} from "./omp-cache.js";
import type { ProviderUsageFetcher } from "./provider.js";
import { ProviderUsageService } from "./service.js";

describe("OMP Usage Cache Adapter & Service", () => {
  let testDir: string;
  let cacheFile: string;
  let weightsFile: string;
  const originalEnvCache = process.env.PASEO_OMP_USAGE_CACHE_PATH;
  const originalEnvWeights = process.env.PASEO_OMP_ACCOUNT_WEIGHTS_PATH;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "omp-cache-test-"));
    cacheFile = join(testDir, "usage-cache.json");
    weightsFile = join(testDir, "account-weights.json");
    delete process.env.PASEO_OMP_USAGE_CACHE_PATH;
    delete process.env.PASEO_OMP_ACCOUNT_WEIGHTS_PATH;
  });

  afterEach(() => {
    if (originalEnvCache !== undefined) {
      process.env.PASEO_OMP_USAGE_CACHE_PATH = originalEnvCache;
    } else {
      delete process.env.PASEO_OMP_USAGE_CACHE_PATH;
    }
    if (originalEnvWeights !== undefined) {
      process.env.PASEO_OMP_ACCOUNT_WEIGHTS_PATH = originalEnvWeights;
    } else {
      delete process.env.PASEO_OMP_ACCOUNT_WEIGHTS_PATH;
    }
    rmSync(testDir, { recursive: true, force: true });
  });

  it("retains generic default tiers only without personal account emails or project IDs", () => {
    expect(DEFAULT_ACCOUNT_WEIGHTS.accounts).toBeUndefined();
    expect(DEFAULT_ACCOUNT_WEIGHTS.tiers).toBeDefined();
    expect(DEFAULT_ACCOUNT_WEIGHTS.tiers?.["ultra"]).toBe(20);
    expect(DEFAULT_ACCOUNT_WEIGHTS.tiers?.["pro"]).toBe(1);
    const serialized = JSON.stringify(DEFAULT_ACCOUNT_WEIGHTS);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("polar-tenure");
    expect(serialized).not.toContain("tranquil-glow");
  });

  it("throws explicit error when account-weights.json is malformed or invalid", () => {
    writeFileSync(weightsFile, "{ invalid json");
    expect(() => loadAccountWeights(weightsFile)).toThrow(/Malformed account weights/);

    writeFileSync(weightsFile, JSON.stringify({ tiers: { ultra: "not-a-number" } }));
    expect(() => loadAccountWeights(weightsFile)).toThrow(
      /Malformed account weights.*validation failed/,
    );
  });

  it("maps display names correctly for anthropic, github-copilot, kimi-code, and standard providers", () => {
    expect(formatProviderDisplayName("anthropic")).toBe("Claude");
    expect(formatProviderDisplayName("github-copilot")).toBe("GitHub Copilot");
    expect(formatProviderDisplayName("kimi-code")).toBe("Kimi");
    expect(formatProviderDisplayName("google-antigravity")).toBe("Google Antigravity");
    expect(formatProviderDisplayName("openai-codex")).toBe("OpenAI Codex");
  });

  it("includes validated accountsWithoutUsage entries as unavailable slots", async () => {
    const fixedNow = Date.now();
    const payload: OmpUsageData = {
      generatedAt: fixedNow,
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: fixedNow,
          limits: [{ id: "m", amount: { remainingFraction: 0.8 } }],
        },
      ],
      accountsWithoutUsage: ["cursor", { provider: "anthropic" }],
    };
    writeFileSync(cacheFile, JSON.stringify(payload));

    const result = await readOmpUsage({
      cachePath: cacheFile,
      now: () => fixedNow,
    });

    expect(result.providers).toHaveLength(3);
    const cursor = result.providers.find((p) => p.providerId === "cursor")!;
    expect(cursor).toBeDefined();
    expect(cursor.status).toBe("unavailable");
    expect(cursor.windows[0]?.usedPct).toBeNull();

    const claude = result.providers.find((p) => p.providerId === "anthropic")!;
    expect(claude).toBeDefined();
    expect(claude.displayName).toBe("Claude");
    expect(claude.status).toBe("unavailable");
  });

  it("treats warning and exhausted limit status as valid usage rather than errors", async () => {
    const fixedNow = Date.now();
    const payload: OmpUsageData = {
      generatedAt: fixedNow,
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: fixedNow,
          limits: [
            {
              id: "weekly",
              status: "exhausted",
              amount: { remainingFraction: 0.0, usedFraction: 1.0 },
            },
          ],
        },
      ],
    };
    writeFileSync(cacheFile, JSON.stringify(payload));

    const result = await readOmpUsage({
      cachePath: cacheFile,
      now: () => fixedNow,
    });

    expect(result.providers).toHaveLength(1);
    const codex = result.providers[0]!;
    expect(codex.status).toBe("available");
    expect(codex.windows[0]?.usedPct).toBe(100);
    expect(codex.windows[0]?.remainingPct).toBe(0);
    expect(codex.error).toBeNull();
  });

  it("performs weighted rollup across multiple accounts matching statusline", async () => {
    const fixedNow = Date.parse("2026-09-08T12:00:00.000Z");
    const weights: AccountWeightsConfig = {
      accounts: {
        "proj-ultra": 20,
        "proj-pro": 1,
      },
    };
    writeFileSync(weightsFile, JSON.stringify(weights));

    const payload: OmpUsageData = {
      generatedAt: fixedNow - 30_000,
      reports: [
        {
          provider: "google-antigravity",
          fetchedAt: fixedNow - 30_000,
          metadata: {
            projectId: "proj-ultra",
            planType: "ultra",
          },
          limits: [
            {
              id: "weekly",
              label: "Weekly Usage",
              amount: {
                remainingFraction: 0.5440737,
                usedFraction: 0.4559263,
              },
            },
          ],
        },
        {
          provider: "google-antigravity",
          fetchedAt: fixedNow - 30_000,
          metadata: {
            projectId: "proj-pro",
            planType: "pro",
          },
          limits: [
            {
              id: "weekly",
              label: "Weekly Usage",
              amount: {
                remainingFraction: 0.0,
                usedFraction: 1.0,
              },
            },
          ],
        },
      ],
    };
    writeFileSync(cacheFile, JSON.stringify(payload));

    const result = await readOmpUsage({
      cachePath: cacheFile,
      accountWeightsPath: weightsFile,
      now: () => fixedNow,
    });

    expect(result.providers).toHaveLength(1);
    const agy = result.providers[0]!;
    expect(agy.providerId).toBe("google-antigravity");
    expect(agy.displayName).toBe("Google Antigravity");
    expect(agy.status).toBe("available");
    expect(agy.windows).toHaveLength(1);
    const window = agy.windows[0]!;
    expect(window.id).toBe("omp-rollup");
    expect(window.label).toBe("Usage");
    // (20 * 0.5440737 + 1 * 0) / 21 = 0.518165 -> 52% remaining, 48% used
    expect(window.remainingPct).toBe(52);
    expect(window.usedPct).toBe(48);
    expect(window.tone).toBe("ok");
  });

  it("aggregates multi-account provider into single ProviderUsage without leaking identifiers", async () => {
    const fixedNow = Date.parse("2026-09-08T12:00:00.000Z");
    const payload: OmpUsageData = {
      generatedAt: fixedNow - 20_000,
      reports: [
        {
          provider: "openai-codex",
          account: "account-1",
          fetchedAt: fixedNow - 20_000,
          metadata: {
            email: "secret1@example.com",
            accountId: "acc-secret-1",
            projectId: "proj-secret-1",
          },
          limits: [
            {
              id: "limit-1",
              label: "Chat",
              amount: { remaining: 100, limit: 100 },
            },
          ],
        },
        {
          provider: "openai-codex",
          account: "account-2",
          fetchedAt: fixedNow - 20_000,
          metadata: {
            email: "secret2@example.com",
            accountId: "acc-secret-2",
            projectId: "proj-secret-2",
          },
          limits: [
            {
              id: "limit-2",
              label: "Chat",
              amount: { remaining: 16, limit: 100 },
            },
          ],
        },
      ],
    };
    writeFileSync(cacheFile, JSON.stringify(payload));

    const result = await readOmpUsage({
      cachePath: cacheFile,
      now: () => fixedNow,
    });

    expect(result.providers).toHaveLength(1);
    const codex = result.providers[0]!;
    expect(codex.providerId).toBe("openai-codex");
    expect(codex.displayName).toBe("OpenAI Codex");
    expect(codex.windows[0]?.remainingPct).toBe(58);
    expect(codex.windows[0]?.usedPct).toBe(42);

    // Verify no private account identifiers leaked in the ProviderUsage object
    const serialized = JSON.stringify(codex);
    expect(serialized).not.toContain("secret1@example.com");
    expect(serialized).not.toContain("secret2@example.com");
    expect(serialized).not.toContain("acc-secret-1");
    expect(serialized).not.toContain("proj-secret-1");
  });

  it("filters out Spark limits so DGX Spark quotas do not skew provider allowance", async () => {
    const fixedNow = Date.parse("2026-09-08T12:00:00.000Z");
    const payload: OmpUsageData = {
      generatedAt: fixedNow - 10_000,
      reports: [
        {
          provider: "google-antigravity",
          fetchedAt: fixedNow - 10_000,
          limits: [
            {
              id: "google-antigravity:spark:spark-quota",
              label: "DGX Spark Limit",
              amount: { remainingFraction: 0.1 },
            },
            {
              id: "google-antigravity:weekly",
              label: "Weekly Allowance",
              amount: { remainingFraction: 0.85 },
            },
          ],
        },
      ],
    };
    writeFileSync(cacheFile, JSON.stringify(payload));

    const result = await readOmpUsage({
      cachePath: cacheFile,
      now: () => fixedNow,
    });

    const agy = result.providers[0]!;
    // Spark limit (10%) is ignored, binding limit is 85% remaining
    expect(agy.windows[0]?.remainingPct).toBe(85);
    expect(agy.windows[0]?.usedPct).toBe(15);
  });

  it("marks provider with no limits as unavailable without inventing 0%", async () => {
    const fixedNow = Date.parse("2026-09-08T12:00:00.000Z");
    const payload: OmpUsageData = {
      generatedAt: fixedNow - 10_000,
      reports: [
        {
          provider: "opencode-go",
          fetchedAt: fixedNow - 10_000,
          limits: [],
          metadata: { planType: "free" },
        },
      ],
    };
    writeFileSync(cacheFile, JSON.stringify(payload));

    const result = await readOmpUsage({
      cachePath: cacheFile,
      now: () => fixedNow,
    });

    expect(result.providers).toHaveLength(1);
    const provider = result.providers[0]!;
    expect(provider.status).toBe("unavailable");
    expect(provider.windows).toHaveLength(1);
    const window = provider.windows[0]!;
    expect(window.id).toBe("omp-rollup");
    expect(window.label).toBe("Usage");
    expect(window.usedPct).toBeNull();
    expect(window.remainingPct).toBeNull();
  });

  it("marks stale cache older than 5 minutes as error so it does not look current", async () => {
    const fixedNow = Date.parse("2026-09-08T12:00:00.000Z");
    // 6 minutes old (> 5 minute threshold)
    const staleTime = fixedNow - 6 * 60 * 1000;
    const payload: OmpUsageData = {
      generatedAt: staleTime,
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: staleTime,
          limits: [
            {
              id: "weekly",
              label: "Weekly",
              amount: { remainingFraction: 0.9 },
            },
          ],
        },
      ],
    };
    writeFileSync(cacheFile, JSON.stringify(payload));

    const result = await readOmpUsage({
      cachePath: cacheFile,
      now: () => fixedNow,
    });

    expect(result.providers).toHaveLength(1);
    const codex = result.providers[0]!;
    expect(codex.status).toBe("error");
    expect(codex.error).toContain("stale");
    expect(codex.fetchedAt).toBe(new Date(staleTime).toISOString());
    expect(codex.windows[0]?.usedPct).toBeNull();
    expect(codex.windows[0]?.remainingPct).toBeNull();
  });

  it("honors stale report.fetchedAt even when generatedAt is fresh", async () => {
    const fixedNow = Date.parse("2026-09-08T12:00:00.000Z");
    const staleReportTime = fixedNow - 7 * 60 * 1000; // 7m old report
    const payload: OmpUsageData = {
      generatedAt: fixedNow - 5_000, // fresh daemon run
      reports: [
        {
          provider: "openai-codex",
          fetchedAt: staleReportTime,
          limits: [
            {
              id: "weekly",
              label: "Weekly",
              amount: { remainingFraction: 0.9 },
            },
          ],
        },
      ],
    };
    writeFileSync(cacheFile, JSON.stringify(payload));

    const result = await readOmpUsage({
      cachePath: cacheFile,
      now: () => fixedNow,
    });

    expect(result.providers).toHaveLength(1);
    const codex = result.providers[0]!;
    expect(codex.status).toBe("error");
    expect(codex.error).toContain("stale");
    expect(codex.windows[0]?.usedPct).toBeNull();
  });

  it("does not let partial failure or stale account make rollup look fully current", async () => {
    const fixedNow = Date.parse("2026-09-08T12:00:00.000Z");
    const payload: OmpUsageData = {
      generatedAt: fixedNow - 10_000,
      reports: [
        {
          provider: "google-antigravity",
          fetchedAt: fixedNow - 10_000,
          limits: [
            {
              id: "weekly",
              amount: { remainingFraction: 0.8 },
            },
          ],
        },
        {
          provider: "google-antigravity",
          fetchedAt: fixedNow - 10_000,
          limits: [], // Second account has no limits / failed
        },
      ],
    };
    writeFileSync(cacheFile, JSON.stringify(payload));

    const result = await readOmpUsage({
      cachePath: cacheFile,
      now: () => fixedNow,
    });

    expect(result.providers).toHaveLength(1);
    const agy = result.providers[0]!;
    expect(agy.status).toBe("error");
    expect(agy.windows[0]?.usedPct).toBeNull();
    expect(agy.windows[0]?.remainingPct).toBeNull();
  });

  it("sanitizes report errors to generic wire message without leaking credentials", async () => {
    const fixedNow = Date.parse("2026-09-08T12:00:00.000Z");
    const payload: OmpUsageData = {
      generatedAt: fixedNow - 10_000,
      reports: [
        {
          provider: "xai-oauth",
          fetchedAt: fixedNow - 10_000,
          error: "Authorization failed for Bearer eyJhbGciOi_SECRET_TOKEN_HERE",
          limits: [],
        },
      ],
    };
    writeFileSync(cacheFile, JSON.stringify(payload));

    const result = await readOmpUsage({
      cachePath: cacheFile,
      now: () => fixedNow,
    });

    expect(result.providers).toHaveLength(1);
    const xai = result.providers[0]!;
    expect(xai.status).toBe("error");
    expect(xai.error).toBe("Provider quota fetch failed");
    expect(JSON.stringify(xai)).not.toContain("SECRET_TOKEN");
  });

  it("returns empty provider list when cache file is missing", async () => {
    const fixedNow = Date.parse("2026-09-08T12:00:00.000Z");
    const missingFile = join(testDir, "non-existent-usage-cache.json");

    const result = await readOmpUsage({
      cachePath: missingFile,
      now: () => fixedNow,
    });

    expect(result.providers).toEqual([]);
    expect(result.fetchedAt).toBe(new Date(fixedNow).toISOString());
  });

  it("throws explicit error when cache file is empty", async () => {
    writeFileSync(cacheFile, "");

    await expect(
      readOmpUsage({
        cachePath: cacheFile,
      }),
    ).rejects.toThrow(/Malformed OMP usage cache/);
  });

  it("throws explicit error when cache file has missing required fields like empty object", async () => {
    writeFileSync(cacheFile, "{}");

    await expect(
      readOmpUsage({
        cachePath: cacheFile,
      }),
    ).rejects.toThrow(/Malformed OMP usage cache.*validation failed/);
  });

  it("throws explicit error when cache file is corrupt JSON syntax", async () => {
    writeFileSync(cacheFile, "{ not valid json syntax");

    await expect(
      readOmpUsage({
        cachePath: cacheFile,
      }),
    ).rejects.toThrow(/Malformed OMP usage cache/);
  });

  it("preserves explicit fetchers injection in ProviderUsageService", async () => {
    let fetchCount = 0;
    const injectedFetcher: ProviderUsageFetcher = {
      providerId: "custom-provider",
      displayName: "Custom Provider",
      fetchUsage: async () => {
        fetchCount += 1;
        return {
          providerId: "custom-provider",
          displayName: "Custom Provider",
          status: "available",
          planLabel: "Enterprise",
          windows: [
            {
              id: "window-1",
              label: "Monthly",
              usedPct: 25,
              remainingPct: 75,
            },
          ],
        };
      },
    };

    const service = new ProviderUsageService({
      logger: pino({ level: "silent" }),
      fetchers: [injectedFetcher],
      cacheTtlMs: 60_000,
      ompUsageCachePath: cacheFile,
    });

    const first = await service.listUsage();
    expect(first.providers).toHaveLength(1);
    expect(first.providers[0]?.providerId).toBe("custom-provider");
    expect(fetchCount).toBe(1);

    // In-memory cache is preserved for explicit fetchers
    const second = await service.listUsage();
    expect(second).toBe(first);
    expect(fetchCount).toBe(1);
  });

  it("reads local cache file on each request in default OMP mode", async () => {
    const fixedNow = Date.parse("2026-09-08T12:00:00.000Z");
    writeFileSync(
      cacheFile,
      JSON.stringify({
        generatedAt: fixedNow,
        reports: [
          {
            provider: "cursor",
            fetchedAt: fixedNow,
            limits: [{ id: "m", label: "Monthly", amount: { remainingFraction: 0.9 } }],
          },
        ],
      }),
    );

    const service = new ProviderUsageService({
      logger: pino({ level: "silent" }),
      ompUsageCachePath: cacheFile,
      now: () => fixedNow,
    });

    const first = await service.listUsage();
    expect(first.providers[0]?.windows[0]?.remainingPct).toBe(90);

    // Overwrite cache file without restarting service
    writeFileSync(
      cacheFile,
      JSON.stringify({
        generatedAt: fixedNow,
        reports: [
          {
            provider: "cursor",
            fetchedAt: fixedNow,
            limits: [{ id: "m", label: "Monthly", amount: { remainingFraction: 0.4 } }],
          },
        ],
      }),
    );

    const updated = await service.listUsage();
    expect(updated.providers[0]?.windows[0]?.remainingPct).toBe(40);
  });
});
