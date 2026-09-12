import { createPreviewAttachmentId } from "@/attachments/utils";

export interface AssistantImageAcquisitionBudget<T> {
  /** Estimated retained bytes for inactive entries. Not a heap measurement. */
  maxWeight: number;
  getWeight(value: T): number;
}

export interface AssistantImageAcquisitionCache<T> {
  acquire(key: string, locate: () => Promise<T>): Promise<T>;
  acquireRetained(
    key: string,
    locate: () => Promise<T>,
  ): { promise: Promise<T>; value?: T; release: () => void };
  peek(key: string): T | undefined;
  size(): number;
}

export function createAssistantImageOccurrenceKey(input: {
  agentId: string;
  itemId: string;
}): string {
  return `${input.agentId}:${input.itemId}`;
}

export function createAssistantImageFilePreviewAttachmentId(input: {
  serverId?: string;
  occurrenceKey: string;
  mimeType: string;
  path: string;
  size: number;
  modifiedAt?: string | null;
  contentLength: number;
}): string {
  return createPreviewAttachmentId({
    mimeType: input.mimeType,
    path: input.path,
    size: input.size,
    modifiedAt: input.modifiedAt,
    contentLength: input.contentLength,
    contentKey: `${input.serverId ?? "unknown-server"}:${input.occurrenceKey}`,
  });
}

export function createAssistantImageFileAcquisitionKey(input: {
  serverId?: string;
  occurrenceKey: string;
  cwd: string;
  path: string;
}): string {
  return `file:${input.serverId ?? "unknown-server"}:${input.occurrenceKey}:${input.cwd}:${input.path}`;
}

export function createAssistantImageAcquisitionCache<T>(input: {
  capacity: number;
  budget?: AssistantImageAcquisitionBudget<T>;
  onRetain?: (value: T) => () => void;
}): AssistantImageAcquisitionCache<T> {
  if (!Number.isInteger(input.capacity) || input.capacity < 1) {
    throw new Error("Assistant image acquisition cache capacity must be a positive integer.");
  }
  const budget = input.budget;
  if (budget !== undefined && !(Number.isFinite(budget.maxWeight) && budget.maxWeight > 0)) {
    throw new Error(
      "Assistant image acquisition cache budget must be a positive, finite maximum weight.",
    );
  }
  interface CacheEntry {
    pending: Promise<T>;
    resolved: boolean;
    weight: number;
    value?: T;
    release: (() => void) | null;
    activeConsumers: number;
  }
  const maxWeight = budget?.maxWeight ?? Infinity;
  const entries = new Map<string, CacheEntry>();
  let totalWeight = 0;

  const evict = (key: string, entry: CacheEntry) => {
    if (entries.get(key) === entry) {
      entries.delete(key);
      totalWeight -= entry.weight;
      entry.weight = 0;
    }
    entry.release?.();
    entry.release = null;
  };

  const enforceLimits = () => {
    while (true) {
      if (entries.size <= input.capacity && totalWeight <= maxWeight) return;
      let evicted = false;
      for (const [key, entry] of entries) {
        if (entry.activeConsumers > 0) {
          continue;
        }
        evict(key, entry);
        evicted = true;
        break;
      }
      if (!evicted) {
        return;
      }
    }
  };

  const acquireEntry = (key: string, locate: () => Promise<T>, retain: boolean): CacheEntry => {
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      if (retain) {
        cached.activeConsumers += 1;
      }
      return cached;
    }
    const pending = locate();
    const entry: CacheEntry = {
      pending,
      resolved: false,
      weight: 0,
      release: null,
      activeConsumers: retain ? 1 : 0,
    };
    entries.set(key, entry);
    enforceLimits();
    void (async () => {
      let release: (() => void) | null = null;
      try {
        const value = await pending;
        const weight = budget === undefined ? 0 : budget.getWeight(value);
        release = input.onRetain?.(value) ?? null;
        const admissible = Number.isFinite(weight) && weight >= 0 && entries.get(key) === entry;
        if (!admissible) {
          // A weight that cannot be charged must never enter the cache, and its
          // retained resources are released exactly once below.
          evict(key, entry);
          release?.();
          return;
        }
        entry.value = value;
        entry.resolved = true;
        entry.weight = weight;
        entry.release = release;
        release = null;
        totalWeight += weight;
        enforceLimits();
      } catch {
        evict(key, entry);
        release?.();
      }
    })();
    return entry;
  };

  return {
    acquire(key, locate) {
      return acquireEntry(key, locate, false).pending;
    },
    acquireRetained(key, locate) {
      const entry = acquireEntry(key, locate, true);
      let released = false;
      return {
        promise: entry.pending,
        ...(entry.resolved ? { value: entry.value } : {}),
        release() {
          if (released) {
            return;
          }
          released = true;
          entry.activeConsumers = Math.max(0, entry.activeConsumers - 1);
          enforceLimits();
        },
      };
    },
    peek(key) {
      const entry = entries.get(key);
      if (!entry?.resolved) {
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return entry.value;
    },
    size() {
      return entries.size;
    },
  };
}
