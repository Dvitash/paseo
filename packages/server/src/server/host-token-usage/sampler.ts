import type { HostTokenUsageSnapshot } from "@getpaseo/protocol/host-token-usage";
import { createHostTokenUsageReader, type HostTokenUsageReading } from "./reader.js";

const CACHE_MS = 60_000;

export interface HostTokenUsageSamplerOptions {
  read?: () => Promise<HostTokenUsageReading>;
  now?: () => number;
}

export class HostTokenUsageSampler {
  private readonly read: () => Promise<HostTokenUsageReading>;
  private readonly now: () => number;
  private snapshot: HostTokenUsageSnapshot | null = null;
  private inFlight: Promise<HostTokenUsageSnapshot> | null = null;

  constructor(options: HostTokenUsageSamplerOptions = {}) {
    this.read = options.read ?? createHostTokenUsageReader();
    this.now = options.now ?? Date.now;
  }

  getSnapshot(force = false): Promise<HostTokenUsageSnapshot> {
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (!force && this.snapshot) {
      const age = now - new Date(this.snapshot.fetchedAt).getTime();
      if (age >= 0 && age < CACHE_MS) return Promise.resolve(this.snapshot);
    }
    this.inFlight = this.sample(now).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async sample(now: number): Promise<HostTokenUsageSnapshot> {
    try {
      const reading = await this.read();
      this.snapshot = {
        status: reading.status,
        ranges: reading.ranges ?? null,
        error: reading.error ?? null,
        fetchedAt: new Date(now).toISOString(),
      };
      return this.snapshot;
    } catch (error) {
      this.snapshot = {
        status: "unavailable",
        ranges: null,
        error: error instanceof Error ? error.message : "Failed to sample host token usage",
        fetchedAt: new Date(now).toISOString(),
      };
      return this.snapshot;
    }
  }
}
