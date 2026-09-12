import { describe, expect, it } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createProjectIconTarget, type ProjectIconTarget } from "./icon-target";
import { ProjectIconCache, type ProjectIconCacheStorage } from "./icon-cache";

const STORAGE_KEY = "@paseo:project-icon-cache";
const CACHE_VERSION = 1;
const MAX_BYTES = 4 * 1024 * 1024;

class MemoryStorage implements ProjectIconCacheStorage {
  readonly values = new Map<string, string>();
  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

const icon = { data: "aWNvbg==", mimeType: "image/png" };

function projectTarget(projectId: string, serverId = "host-a"): ProjectIconTarget {
  const target = createProjectIconTarget({
    projectViewKey: `${serverId}:${projectId}`,
    placement: {
      serverId,
      projectId,
      iconWorkingDir: `/${projectId}`,
      iconRevision: "revision-a",
    },
  });
  if (!target) throw new Error("Expected project icon target");
  return target;
}

function sizedIcon(characters: number) {
  return { data: "A".repeat(characters), mimeType: "image/png" };
}

function clientWith(iconResult: typeof icon | null) {
  return {
    getProjectIcon: async () => ({ requestId: "icon", icon: iconResult }),
  } as unknown as DaemonClient;
}

function storedEntry(projectId: string, entryIcon: typeof icon | null, serverId = "host-a") {
  return { serverId, projectId, revision: "revision-a", icon: entryIcon };
}

function seedStorage(entries: unknown[]): MemoryStorage {
  const storage = new MemoryStorage();
  storage.values.set(STORAGE_KEY, JSON.stringify({ version: CACHE_VERSION, entries }));
  return storage;
}

function restoredCache(storage: ProjectIconCacheStorage, serverIds: string[]): ProjectIconCache {
  const cache = new ProjectIconCache(storage);
  cache.setHosts(serverIds);
  return cache;
}

function persistedProjectIds(storage: MemoryStorage): string[] {
  const raw = storage.values.get(STORAGE_KEY);
  if (raw === undefined) return [];
  const parsed = JSON.parse(raw) as { entries: Array<{ projectId: string }> };
  return parsed.entries.map((entry) => entry.projectId);
}

describe("ProjectIconCache", () => {
  it("uses the shared target revision in its query key", () => {
    const cache = new ProjectIconCache(new MemoryStorage());

    expect(cache.query(projectTarget("project-a"), true, () => null, false).queryKey).toEqual([
      "projectIcon",
      "host-a",
      "project-a",
      "revision-a",
    ]);
  });

  it("resolves, persists, and hydrates an icon before a host connects", async () => {
    const storage = new MemoryStorage();
    const writer = new ProjectIconCache(storage);
    writer.setHosts(["host-a"]);
    await writer.query(projectTarget("project-a"), true, () => clientWith(icon), true).queryFn();
    await writer.flush();

    const reader = restoredCache(storage, ["host-a"]);
    await reader.restore();

    expect(reader.query(projectTarget("project-a"), true, () => null, false).initialData).toEqual(
      icon,
    );
  });

  it("persists an explicit no-icon result", async () => {
    const storage = new MemoryStorage();
    const writer = new ProjectIconCache(storage);
    writer.setHosts(["host-a"]);
    await writer.query(projectTarget("project-a"), true, () => clientWith(null), true).queryFn();
    await writer.flush();

    const reader = restoredCache(storage, ["host-a"]);
    await reader.restore();
    expect(reader.query(projectTarget("project-a"), true, () => null, false)).toHaveProperty(
      "initialData",
      null,
    );
  });

  it("misses only the project whose revision changed", async () => {
    const cache = new ProjectIconCache(new MemoryStorage());
    await cache.query(projectTarget("project-a"), true, () => clientWith(icon), true).queryFn();
    await cache.query(projectTarget("project-b"), true, () => clientWith(null), true).queryFn();

    expect(
      cache.query(
        { ...projectTarget("project-a"), iconRevision: "revision-b" },
        true,
        () => null,
        false,
      ),
    ).not.toHaveProperty("initialData");
    expect(cache.query(projectTarget("project-b"), true, () => null, false)).toHaveProperty(
      "initialData",
      null,
    );
  });

  it("drops restored entries past the entry cap and keeps the newest", async () => {
    const entries = Array.from({ length: 600 }, (_, index) =>
      storedEntry(`project-${index}`, null),
    );
    const cache = restoredCache(seedStorage(entries), ["host-a"]);
    await cache.restore();

    expect(cache.query(projectTarget("project-0"), true, () => null, false)).not.toHaveProperty(
      "initialData",
    );
    expect(cache.query(projectTarget("project-599"), true, () => null, false)).toHaveProperty(
      "initialData",
      null,
    );
  });

  it("bounds restored bytes and rewrites only the surviving entries", async () => {
    // 2,000,266 bytes per entry, so six entries are ~3x the 4 MiB budget while far below the
    // 512-entry cap: only the byte budget can explain the eviction.
    const large = sizedIcon(1_000_000);
    const entries = Array.from({ length: 6 }, (_, index) => storedEntry(`project-${index}`, large));
    const storage = seedStorage(entries);
    const cache = restoredCache(storage, ["host-a"]);
    await cache.restore();

    expect(cache.query(projectTarget("project-2"), true, () => null, false)).not.toHaveProperty(
      "initialData",
    );
    expect(cache.query(projectTarget("project-4"), true, () => null, false)).toHaveProperty(
      "initialData",
      large,
    );
    expect(cache.query(projectTarget("project-5"), true, () => null, false)).toHaveProperty(
      "initialData",
      large,
    );

    await cache.flush();
    expect(persistedProjectIds(storage).sort()).toEqual(["project-4", "project-5"]);
  });

  it("enforces the byte budget while admitting a payload that repeats a key", async () => {
    const storage = seedStorage([
      storedEntry("project-a", sizedIcon(1_200_000)),
      storedEntry("project-b", sizedIcon(1_400_000)),
      // Repeats project-b. Admitting the first two already exceeds 4 MiB, so enforcing during
      // admission drops project-a before this replacement lands; enforcing only once the whole
      // payload is built instead keeps project-a, since the shrunken project-b frees room.
      storedEntry("project-b", sizedIcon(300_000)),
    ]);
    const cache = restoredCache(storage, ["host-a"]);
    await cache.restore();

    expect(cache.query(projectTarget("project-b"), true, () => null, false)).toHaveProperty(
      "initialData",
      sizedIcon(300_000),
    );
    expect(cache.query(projectTarget("project-a"), true, () => null, false)).not.toHaveProperty(
      "initialData",
    );

    await cache.flush();
    expect(persistedProjectIds(storage)).toEqual(["project-b"]);
  });

  it("evicts the oldest written icons once the byte budget is reached", async () => {
    const cache = new ProjectIconCache(new MemoryStorage());
    cache.setHosts(["host-a"]);
    const large = sizedIcon(1_000_000);
    for (let index = 0; index < 6; index += 1) {
      await cache
        .query(projectTarget(`project-${index}`), true, () => clientWith(large), true)
        .queryFn();
    }

    expect(cache.query(projectTarget("project-0"), true, () => null, false)).not.toHaveProperty(
      "initialData",
    );
    expect(cache.query(projectTarget("project-3"), true, () => null, false)).not.toHaveProperty(
      "initialData",
    );
    expect(cache.query(projectTarget("project-4"), true, () => null, false)).toHaveProperty(
      "initialData",
      large,
    );
    expect(cache.query(projectTarget("project-5"), true, () => null, false)).toHaveProperty(
      "initialData",
      large,
    );
  });

  it("skips an oversized icon without evicting the entries already held", async () => {
    const cache = new ProjectIconCache(new MemoryStorage());
    cache.setHosts(["host-a"]);
    await cache.query(projectTarget("project-a"), true, () => clientWith(icon), true).queryFn();
    // The payload alone is exactly 4 MiB of UTF-16 bytes, so only a byte (not code unit) charge
    // can classify this as oversized.
    const oversized = sizedIcon(MAX_BYTES / 2);
    await cache
      .query(projectTarget("project-b"), true, () => clientWith(oversized), true)
      .queryFn();

    expect(cache.query(projectTarget("project-b"), true, () => null, false)).not.toHaveProperty(
      "initialData",
    );
    expect(cache.query(projectTarget("project-a"), true, () => null, false)).toHaveProperty(
      "initialData",
      icon,
    );
  });

  it("evicts by real access recency rather than insertion order", async () => {
    const cache = new ProjectIconCache(new MemoryStorage());
    cache.setHosts(["host-a"]);
    await cache.query(projectTarget("project-a"), true, () => clientWith(icon), true).queryFn();
    await cache.query(projectTarget("project-b"), true, () => clientWith(null), true).queryFn();
    expect(cache.query(projectTarget("project-a"), true, () => null, false)).toHaveProperty(
      "initialData",
      icon,
    );

    for (let index = 0; index < 511; index += 1) {
      await cache
        .query(projectTarget(`project-fill-${index}`), true, () => clientWith(null), true)
        .queryFn();
    }

    expect(cache.query(projectTarget("project-b"), true, () => null, false)).not.toHaveProperty(
      "initialData",
    );
    expect(cache.query(projectTarget("project-a"), true, () => null, false)).toHaveProperty(
      "initialData",
      icon,
    );
  });

  it("drops held icons when their host is no longer active", async () => {
    const storage = new MemoryStorage();
    const cache = new ProjectIconCache(storage);
    cache.setHosts(["host-a", "host-b"]);
    await cache.query(projectTarget("project-a"), true, () => clientWith(icon), true).queryFn();
    await cache
      .query(projectTarget("project-a", "host-b"), true, () => clientWith(icon), true)
      .queryFn();

    cache.setHosts(["host-a"]);
    await cache.flush();

    const reader = restoredCache(storage, ["host-a", "host-b"]);
    await reader.restore();
    expect(reader.query(projectTarget("project-a"), true, () => null, false)).toHaveProperty(
      "initialData",
      icon,
    );
    expect(
      reader.query(projectTarget("project-a", "host-b"), true, () => null, false),
    ).not.toHaveProperty("initialData");
  });

  it("moves rekeyed bytes instead of charging them twice", async () => {
    const cache = new ProjectIconCache(new MemoryStorage());
    cache.setHosts(["host-a"]);
    // project-z occupies 1,993,804 bytes and project-a 2,200,000: together 500 bytes under the
    // budget, which only holds if the rekey moves project-a. Charging it twice instead totals
    // 6,393,804 and forces the oldest live entry out.
    const retained = sizedIcon(996_769);
    await cache.query(projectTarget("project-z"), true, () => clientWith(retained), true).queryFn();
    const rekeyed = sizedIcon(1_099_867);
    await cache.query(projectTarget("project-a"), true, () => clientWith(rekeyed), true).queryFn();

    cache.reconcileServerId("host-a", "host-b");

    expect(
      cache.query(projectTarget("project-z", "host-b"), true, () => null, false),
    ).toHaveProperty("initialData", retained);
    expect(
      cache.query(projectTarget("project-a", "host-b"), true, () => null, false),
    ).toHaveProperty("initialData", rekeyed);
  });

  it("charges a colliding rekeyed entry once", async () => {
    const cache = new ProjectIconCache(new MemoryStorage());
    cache.setHosts(["host-a", "host-b"]);
    const colliding = sizedIcon(1_000_000);
    await cache
      .query(projectTarget("project-a"), true, () => clientWith(colliding), true)
      .queryFn();
    // Same key as the host-a entry: rekeying host-a onto host-b must replace it, not add to it.
    await cache
      .query(projectTarget("project-a", "host-b"), true, () => clientWith(colliding), true)
      .queryFn();

    cache.reconcileServerId("host-a", "host-b");
    const sibling = sizedIcon(1_000_000);
    await cache
      .query(projectTarget("project-b", "host-b"), true, () => clientWith(sibling), true)
      .queryFn();

    expect(
      cache.query(projectTarget("project-a", "host-b"), true, () => null, false),
    ).toHaveProperty("initialData", colliding);
    expect(
      cache.query(projectTarget("project-b", "host-b"), true, () => null, false),
    ).toHaveProperty("initialData", sibling);
  });

  it("keeps accounting exact when an existing icon is replaced", async () => {
    const cache = new ProjectIconCache(new MemoryStorage());
    cache.setHosts(["host-a"]);
    // Each pair is 4,000,532 bytes, just under the budget: double counting the replacement's
    // predecessor would leave only ~194 KiB free and evict project-b.
    const replaced = sizedIcon(1_000_000);
    await cache.query(projectTarget("project-a"), true, () => clientWith(replaced), true).queryFn();
    await cache.query(projectTarget("project-b"), true, () => clientWith(replaced), true).queryFn();

    const replacement = sizedIcon(1_000_000);
    await cache
      .query(projectTarget("project-a"), true, () => clientWith(replacement), true)
      .queryFn();

    expect(cache.query(projectTarget("project-a"), true, () => null, false)).toHaveProperty(
      "initialData",
      replacement,
    );
    expect(cache.query(projectTarget("project-b"), true, () => null, false)).toHaveProperty(
      "initialData",
      replaced,
    );
  });

  it("evicts for the longer keys a rekey creates", async () => {
    const storage = new MemoryStorage();
    const cache = new ProjectIconCache(storage);
    cache.setHosts(["h"]);
    const longHost = "h".padEnd(1_000, "x");
    const pinned = sizedIcon(1_048_000);
    await cache
      .query(projectTarget("project-a", "h"), true, () => clientWith(pinned), true)
      .queryFn();
    const sibling = sizedIcon(1_048_000);
    await cache
      .query(projectTarget("project-b", "h"), true, () => clientWith(sibling), true)
      .queryFn();

    cache.reconcileServerId("h", longHost);

    expect(
      cache.query(projectTarget("project-a", longHost), true, () => null, false),
    ).not.toHaveProperty("initialData");
    expect(
      cache.query(projectTarget("project-b", longHost), true, () => null, false),
    ).toHaveProperty("initialData", sibling);

    await cache.flush();
    expect(persistedProjectIds(storage)).toEqual(["project-b"]);
  });

  it("drops a rekeyed entry whose longer key pushes it past the budget alone", async () => {
    const storage = new MemoryStorage();
    const cache = new ProjectIconCache(storage);
    cache.setHosts(["h"]);
    const longHost = "h".padEnd(1_000, "x");
    // 4,191,550 bytes under the short key (admitted), 4,195,550 under the long one.
    const pinned = sizedIcon(2_095_652);
    await cache
      .query(projectTarget("project-a", "h"), true, () => clientWith(pinned), true)
      .queryFn();
    expect(cache.query(projectTarget("project-a", "h"), true, () => null, false)).toHaveProperty(
      "initialData",
      pinned,
    );

    cache.reconcileServerId("h", longHost);
    await cache.flush();

    expect(persistedProjectIds(storage)).toEqual([]);
    expect(
      cache.query(projectTarget("project-a", longHost), true, () => null, false),
    ).not.toHaveProperty("initialData");
  });
});
