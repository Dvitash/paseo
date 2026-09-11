import type { Logger } from "pino";
import { createProviderUsageFetchers } from "./manifest.js";
import { readOmpUsage, type ProviderUsageListResult } from "./omp-cache.js";
import type { ProviderApiFetch, ProviderUsageFetcher } from "./provider.js";
import { unavailableUsage } from "./usage.js";

export interface ProviderUsageServiceOptions {
  logger: Logger;
  fetchers?: ProviderUsageFetcher[];
  fetch?: ProviderApiFetch;
  cacheTtlMs?: number;
  now?: () => number;
  ompUsageCachePath?: string;
  ompAccountWeightsPath?: string;
  ompAgentDbPath?: string;
}

export type { ProviderUsageListResult };

const DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS = 5 * 60 * 1000;

export class ProviderUsageService {
  private readonly logger: Logger;
  private readonly fetchers?: ProviderUsageFetcher[];
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly ompUsageCachePath?: string;
  private readonly ompAccountWeightsPath?: string;
  private readonly ompAgentDbPath?: string;
  private cached: { fetchedAtMs: number; result: ProviderUsageListResult } | null = null;
  private inFlight: Promise<ProviderUsageListResult> | null = null;

  constructor(options: ProviderUsageServiceOptions) {
    this.logger = options.logger.child({ module: "provider-usage-service" });
    if (options.fetchers) {
      this.fetchers = options.fetchers;
    } else if (options.fetch) {
      this.fetchers = createProviderUsageFetchers({
        logger: this.logger,
        fetch: options.fetch,
      });
    } else {
      this.fetchers = undefined;
    }
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_PROVIDER_USAGE_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.ompUsageCachePath = options.ompUsageCachePath;
    this.ompAccountWeightsPath = options.ompAccountWeightsPath;
    this.ompAgentDbPath = options.ompAgentDbPath;
  }

  async listUsage(options?: { forceRefresh?: boolean }): Promise<ProviderUsageListResult> {
    const nowMs = this.now();
    if (this.fetchers) {
      if (
        !options?.forceRefresh &&
        this.cached &&
        nowMs - this.cached.fetchedAtMs < this.cacheTtlMs
      ) {
        return this.cached.result;
      }

      if (this.inFlight) {
        return this.inFlight;
      }

      const request = this.fetchFreshUsage(nowMs);
      this.inFlight = request;
      try {
        return await request;
      } finally {
        if (this.inFlight === request) {
          this.inFlight = null;
        }
      }
    }

    if (this.inFlight) {
      return this.inFlight;
    }

    const request = readOmpUsage({
      cachePath: this.ompUsageCachePath,
      accountWeightsPath: this.ompAccountWeightsPath,
      agentDbPath: this.ompAgentDbPath,
      now: this.now,
      logger: this.logger,
    });
    this.inFlight = request;
    try {
      return await request;
    } finally {
      if (this.inFlight === request) {
        this.inFlight = null;
      }
    }
  }

  private async fetchFreshUsage(nowMs: number): Promise<ProviderUsageListResult> {
    const fetchers = this.fetchers ?? [];
    const settled = await Promise.allSettled(fetchers.map((fetcher) => fetcher.fetchUsage()));
    const providers = settled.map((result, index) => {
      const fetcher = fetchers[index];
      if (result.status === "fulfilled") {
        return result.value;
      }
      this.logger.debug(
        { err: result.reason, providerId: fetcher.providerId },
        "Provider usage fetch failed",
      );
      return unavailableUsage({
        providerId: fetcher.providerId,
        displayName: fetcher.displayName,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    });

    const result = { fetchedAt: new Date(nowMs).toISOString(), providers };
    this.cached = { fetchedAtMs: nowMs, result };
    return result;
  }
}
