import { existsSync, readFileSync } from "node:fs";
import type pino from "pino";
import type { WebPushSubscription } from "@getpaseo/protocol/messages";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";
import { validatePushEndpoint, validateSubscriptionKeys } from "./web-push-validation.js";

export const WEB_PUSH_LEASE_MS = 48 * 60 * 60 * 1000;
export const MAX_TOTAL_WEB_PUSH_SUBSCRIPTIONS = 500;
export const MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL = 20;

export interface StoredWebPushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  principalId: string;
  clientId: string;
  /** "mobile" | "desktop" as reported by the subscribing client; absent on legacy rows. */
  deviceClass?: "mobile" | "desktop";
  createdAt: number;
  expiresAt: number;
}

interface SerializedSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  principalId: string;
  clientId?: string;
  deviceClass?: "mobile" | "desktop";
  createdAt: string;
  expiresAt: string;
}

interface PersistedPushFile {
  version: 1;
  subscriptions: SerializedSubscription[];
}

function safeHostFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "unknown";
  }
}

/**
 * Storage for Web Push subscriptions.
 *
 * Requirements:
 * - Keyed by endpoint with authenticated principal and client ownership.
 * - Sibling app registrations cannot overwrite an endpoint registered to another client/principal.
 * - Private atomic persistence (mode 0600).
 * - 48h finite lease, renewed on client activity/reconnect.
 * - Cross-restart persistence with principal/client ownership.
 * - Bounded storage (capacity limits).
 * - Permission loss removes all principal records across all client identities.
 * - Zero endpoints or keys in logs.
 */
export class WebPushStore {
  private readonly logger: pino.Logger;
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly write: typeof writePrivateFileAtomicSync;
  private subscriptions = new Map<string, StoredWebPushSubscription>();

  constructor(
    logger: pino.Logger,
    filePath: string,
    now: () => number = Date.now,
    leaseMs: number = WEB_PUSH_LEASE_MS,
    write: typeof writePrivateFileAtomicSync = writePrivateFileAtomicSync,
  ) {
    this.logger = logger.child({ component: "web-push-store" });
    this.filePath = filePath;
    this.now = now;
    this.leaseMs = leaseMs;
    this.write = write;
    this.loadFromDisk();
  }

  subscribe(subscription: WebPushSubscription, principalId: string, clientId?: string): void {
    if (!principalId || typeof principalId !== "string") {
      throw new Error("Cannot register push subscription without authenticated principal");
    }

    validatePushEndpoint(subscription.endpoint);
    const keys = validateSubscriptionKeys(subscription.keys);
    const endpoint = subscription.endpoint.trim();
    const effectiveClientId = (clientId ?? "default").trim();
    const now = this.now();

    const existing = this.subscriptions.get(endpoint);
    if (existing) {
      if (
        existing.principalId !== principalId ||
        (existing.clientId && existing.clientId !== effectiveClientId)
      ) {
        this.logger.warn(
          {
            host: safeHostFromEndpoint(endpoint),
            requestPrincipal: principalId,
            ownerPrincipal: existing.principalId,
          },
          "Rejected subscription update: endpoint registered to different principal or client",
        );
        throw new Error(
          "Push subscription endpoint is already registered to another authenticated client",
        );
      }

      // Same owner: update keys, refresh device class, and renew lease
      const updated: StoredWebPushSubscription = {
        ...existing,
        keys,
        clientId: effectiveClientId,
        deviceClass: subscription.deviceClass ?? existing.deviceClass,
        expiresAt: now + this.leaseMs,
      };

      const next = new Map(this.subscriptions);
      next.set(endpoint, updated);
      this.persist(next);
      this.subscriptions = next;

      this.logger.debug(
        { principalId, host: safeHostFromEndpoint(endpoint) },
        "Renewed existing web push subscription",
      );
      return;
    }

    // New subscription: enforce bounds
    this.pruneExpiredInMemory(now);

    const principalSubscriptions = Array.from(this.subscriptions.values()).filter(
      (sub) => sub.principalId === principalId,
    );

    const next = new Map(this.subscriptions);

    // If principal hit per-principal limit, evict their oldest subscription
    if (principalSubscriptions.length >= MAX_WEB_PUSH_SUBSCRIPTIONS_PER_PRINCIPAL) {
      principalSubscriptions.sort((a, b) => a.createdAt - b.createdAt);
      const oldest = principalSubscriptions[0];
      if (oldest) {
        next.delete(oldest.endpoint);
        this.logger.debug(
          { principalId, evictedHost: safeHostFromEndpoint(oldest.endpoint) },
          "Evicted oldest subscription for principal to stay within quota",
        );
      }
    }

    // Check global quota
    if (next.size >= MAX_TOTAL_WEB_PUSH_SUBSCRIPTIONS) {
      this.logger.warn({ total: next.size }, "Web push subscription storage capacity reached");
      throw new Error("Web push subscription storage capacity reached");
    }

    const newSub: StoredWebPushSubscription = {
      endpoint,
      keys,
      principalId,
      clientId: effectiveClientId,
      deviceClass: subscription.deviceClass,
      createdAt: now,
      expiresAt: now + this.leaseMs,
    };

    next.set(endpoint, newSub);
    this.persist(next);
    this.subscriptions = next;

    this.logger.info(
      { principalId, host: safeHostFromEndpoint(endpoint), total: next.size },
      "Registered new web push subscription",
    );
  }

  unsubscribe(endpoint: string, principalId: string, clientId?: string): boolean {
    const normalized = endpoint.trim();
    if (!normalized) return false;

    const existing = this.subscriptions.get(normalized);
    if (!existing) {
      return false;
    }

    if (
      existing.principalId !== principalId ||
      (clientId && existing.clientId && existing.clientId !== clientId.trim())
    ) {
      this.logger.warn(
        {
          host: safeHostFromEndpoint(normalized),
          requestPrincipal: principalId,
          ownerPrincipal: existing.principalId,
        },
        "Rejected unsubscribe: endpoint registered to different principal or client",
      );
      throw new Error("Not authorized to unsubscribe push subscription owned by another client");
    }

    const next = new Map(this.subscriptions);
    next.delete(normalized);
    this.persist(next);
    this.subscriptions = next;

    this.logger.info(
      { principalId, host: safeHostFromEndpoint(normalized), total: next.size },
      "Unsubscribed web push subscription",
    );
    return true;
  }

  renewPrincipal(principalId: string, clientId?: string): void {
    if (!principalId) return;
    const now = this.now();
    let hasChanges = false;
    const next = new Map(this.subscriptions);
    const filterClientId = clientId?.trim();

    for (const [endpoint, sub] of this.subscriptions) {
      if (sub.principalId === principalId) {
        if (filterClientId && sub.clientId && sub.clientId !== filterClientId) {
          continue;
        }
        if (sub.expiresAt <= now) {
          next.delete(endpoint);
          hasChanges = true;
          continue;
        }
        // If lease is less than half expired, avoid disk thrashing
        if (sub.expiresAt - now > this.leaseMs / 2) {
          continue;
        }
        next.set(endpoint, {
          ...sub,
          expiresAt: now + this.leaseMs,
        });
        hasChanges = true;
      }
    }

    if (hasChanges) {
      try {
        this.persist(next);
        this.subscriptions = next;
        this.logger.debug({ principalId }, "Renewed subscriptions for principal");
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn({ err, principalId }, "Failed to persist renewed subscriptions");
      }
    }
  }

  revokePrincipal(principalId: string): number {
    if (!principalId) return 0;
    const next = new Map(this.subscriptions);
    let removedCount = 0;

    for (const [endpoint, sub] of this.subscriptions) {
      if (sub.principalId === principalId) {
        next.delete(endpoint);
        removedCount++;
      }
    }

    if (removedCount > 0) {
      // Drop in-memory immediately so revoked recipients cannot receive active pushes
      this.subscriptions = next;
      try {
        this.persist(next);
        this.logger.info({ principalId, removedCount }, "Revoked all subscriptions for principal");
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.error({ err, principalId }, "Failed to persist revoked subscriptions to disk");
        throw err;
      }
    }

    return removedCount;
  }

  removeEndpoint(endpoint: string): boolean {
    const normalized = endpoint.trim();
    if (!this.subscriptions.has(normalized)) return false;

    const next = new Map(this.subscriptions);
    next.delete(normalized);
    // Drop in-memory immediately
    this.subscriptions = next;
    try {
      this.persist(next);
      this.logger.info(
        { host: safeHostFromEndpoint(normalized), total: next.size },
        "Removed expired or 410/404 web push endpoint",
      );
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist removal of endpoint to disk");
      return false;
    }
  }

  getSubscription(endpoint: string): StoredWebPushSubscription | undefined {
    const normalized = endpoint.trim();
    const sub = this.subscriptions.get(normalized);
    if (!sub) return undefined;
    if (sub.expiresAt <= this.now()) {
      this.removeEndpoint(normalized);
      return undefined;
    }
    return sub;
  }

  getActiveSubscriptions(): StoredWebPushSubscription[] {
    const now = this.now();
    let expiredCount = 0;
    const active: StoredWebPushSubscription[] = [];
    const next = new Map(this.subscriptions);

    for (const [endpoint, sub] of this.subscriptions) {
      if (sub.expiresAt <= now) {
        next.delete(endpoint);
        expiredCount++;
      } else {
        active.push(sub);
      }
    }

    if (expiredCount > 0) {
      // Drop in-memory immediately so expired endpoints are not retried
      this.subscriptions = next;
      try {
        this.persist(next);
        this.logger.debug({ expiredCount, remaining: next.size }, "Pruned expired subscriptions");
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger.warn({ err }, "Failed to persist pruned expired subscriptions to disk");
      }
    }

    return active;
  }

  private pruneExpiredInMemory(now: number): void {
    let pruned = false;
    const next = new Map(this.subscriptions);
    for (const [endpoint, sub] of this.subscriptions) {
      if (sub.expiresAt <= now) {
        next.delete(endpoint);
        pruned = true;
      }
    }
    if (pruned) {
      try {
        this.persist(next);
        this.subscriptions = next;
      } catch {
        // Ignored
      }
    }
  }

  private loadFromDisk(): void {
    try {
      if (!existsSync(this.filePath)) {
        return;
      }
      ensurePrivateFile(this.filePath);
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as PersistedPushFile;
      const loaded = new Map<string, StoredWebPushSubscription>();
      const now = this.now();

      const items = Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [];
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const { endpoint, keys, principalId, clientId, deviceClass, createdAt, expiresAt } = item;
        if (
          typeof endpoint !== "string" ||
          typeof principalId !== "string" ||
          !keys ||
          typeof keys !== "object"
        ) {
          continue;
        }

        const expiresAtMs = Date.parse(expiresAt);
        const createdAtMs = Date.parse(createdAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
          continue;
        }

        try {
          validatePushEndpoint(endpoint);
          const validKeys = validateSubscriptionKeys(keys);
          loaded.set(endpoint.trim(), {
            endpoint: endpoint.trim(),
            keys: validKeys,
            principalId: principalId.trim(),
            clientId: typeof clientId === "string" ? clientId.trim() : "default",
            deviceClass:
              deviceClass === "mobile" || deviceClass === "desktop" ? deviceClass : undefined,
            createdAt: Number.isFinite(createdAtMs) ? createdAtMs : now,
            expiresAt: expiresAtMs,
          });
        } catch {
          // Skip corrupt or invalid entries
        }
      }

      this.subscriptions = loaded;
      this.logger.info({ total: this.subscriptions.size }, "Loaded web push subscriptions");
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to load web push subscriptions from disk");
    }
  }

  private persist(subscriptions: ReadonlyMap<string, StoredWebPushSubscription>): void {
    try {
      const payload: PersistedPushFile = {
        version: 1,
        subscriptions: Array.from(subscriptions.values()).map((sub) => ({
          endpoint: sub.endpoint,
          keys: sub.keys,
          principalId: sub.principalId,
          clientId: sub.clientId,
          deviceClass: sub.deviceClass,
          createdAt: new Date(sub.createdAt).toISOString(),
          expiresAt: new Date(sub.expiresAt).toISOString(),
        })),
      };
      this.write(this.filePath, JSON.stringify(payload, null, 2) + "\n");
      ensurePrivateFile(this.filePath);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.warn({ err }, "Failed to persist web push subscriptions");
      throw err;
    }
  }
}
