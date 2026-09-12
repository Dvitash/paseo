import { describe, expect, it } from "vitest";
import {
  collectRetainedAttachmentIds,
  retainAttachmentForGarbageCollection,
} from "@/attachments/gc-retention";
import {
  createAssistantImageAcquisitionCache,
  createAssistantImageFileAcquisitionKey,
  createAssistantImageFilePreviewAttachmentId,
  createAssistantImageOccurrenceKey,
} from "./acquisition-cache";

interface WeighedValue {
  id: string;
  bytes: number;
}

describe("assistant image acquisition cache", () => {
  it("evicts a rejected acquisition so the next request can retry", async () => {
    const cache = createAssistantImageAcquisitionCache<string>({
      capacity: 2,
      budget: { maxWeight: 10, getWeight: (value) => value.length },
    });
    let attempts = 0;

    await expect(
      cache.acquire("image", async () => {
        attempts += 1;
        throw new Error("first attempt failed");
      }),
    ).rejects.toThrow("first attempt failed");
    const recovered = await cache.acquire("image", async () => {
      attempts += 1;
      return "recovered";
    });

    expect({ attempts, recovered, size: cache.size() }).toEqual({
      attempts: 2,
      recovered: "recovered",
      size: 1,
    });
  });

  it("bounds successful acquisitions and evicts the least recently used entry", async () => {
    const cache = createAssistantImageAcquisitionCache<string>({ capacity: 2 });
    const located: string[] = [];
    const locate = async (key: string) => {
      located.push(key);
      return key;
    };

    await cache.acquire("a", async () => await locate("a"));
    await cache.acquire("b", async () => await locate("b"));
    await cache.acquire("a", async () => await locate("a-again"));
    await cache.acquire("c", async () => await locate("c"));
    await cache.acquire("b", async () => await locate("b-again"));

    expect({ located, size: cache.size() }).toEqual({
      located: ["a", "b", "c", "b-again"],
      size: 2,
    });
  });

  it("reuses an acquired image when the current locator is unavailable", async () => {
    const cache = createAssistantImageAcquisitionCache<string>({ capacity: 2 });
    let unavailableCalls = 0;

    await cache.acquire("message:image", async () => "persisted attachment");
    const cached = await cache.acquire("message:image", async () => {
      unavailableCalls += 1;
      throw new Error("daemon disconnected");
    });

    expect({ cached, unavailableCalls }).toEqual({
      cached: "persisted attachment",
      unavailableCalls: 0,
    });
    expect(cache.peek("message:image")).toBe("persisted attachment");
  });

  it("scopes file acquisitions to the rendered message occurrence", () => {
    const first = createAssistantImageFileAcquisitionKey({
      serverId: "server",
      occurrenceKey: "message-1:image-1",
      cwd: "/workspace",
      path: "screenshot.png",
    });
    const remount = createAssistantImageFileAcquisitionKey({
      serverId: "server",
      occurrenceKey: "message-1:image-1",
      cwd: "/workspace",
      path: "screenshot.png",
    });
    const laterMessage = createAssistantImageFileAcquisitionKey({
      serverId: "server",
      occurrenceKey: "message-2:image-1",
      cwd: "/workspace",
      path: "screenshot.png",
    });

    expect(remount).toBe(first);
    expect(laterMessage).not.toBe(first);
  });

  it("scopes persisted file previews to the rendered message occurrence", () => {
    const first = createAssistantImageFilePreviewAttachmentId({
      serverId: "server-1",
      occurrenceKey: "message-1:image-1",
      mimeType: "image/png",
      path: "/workspace/screenshot.png",
      size: 512,
      modifiedAt: "2026-07-27T12:00:00.000Z",
      contentLength: 512,
    });
    const second = createAssistantImageFilePreviewAttachmentId({
      serverId: "server-1",
      occurrenceKey: "message-2:image-1",
      mimeType: "image/png",
      path: "/workspace/screenshot.png",
      size: 512,
      modifiedAt: "2026-07-27T12:00:00.000Z",
      contentLength: 512,
    });

    expect(second).not.toBe(first);
  });

  it("scopes message occurrences to their agent", () => {
    const first = createAssistantImageOccurrenceKey({ agentId: "agent-1", itemId: "message-1" });
    const second = createAssistantImageOccurrenceKey({ agentId: "agent-2", itemId: "message-1" });

    expect(second).not.toBe(first);
  });

  it("retains successful values until their cache entry is evicted", async () => {
    const retained: string[] = [];
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<string>({
      capacity: 1,
      onRetain(value) {
        retained.push(value);
        return () => released.push(value);
      },
    });

    await cache.acquire("first", async () => "attachment-1");
    expect({ retained, released }).toEqual({ retained: ["attachment-1"], released: [] });

    await cache.acquire("second", async () => "attachment-2");
    expect({ retained, released }).toEqual({
      retained: ["attachment-1", "attachment-2"],
      released: ["attachment-1"],
    });
  });

  it("does not evict a value while an active consumer retains it", async () => {
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<string>({
      capacity: 1,
      onRetain: (value) => () => released.push(value),
    });

    const first = cache.acquireRetained("first", async () => "attachment-1");
    await first.promise;
    const second = cache.acquireRetained("second", async () => "attachment-2");
    await second.promise;

    expect({ released, size: cache.size() }).toEqual({ released: [], size: 2 });

    first.release();
    expect({ released, size: cache.size() }).toEqual({
      released: ["attachment-1"],
      size: 1,
    });
    second.release();
  });

  it("protects every actively consumed attachment from garbage collection past capacity", async () => {
    const cache = createAssistantImageAcquisitionCache<{ id: string }>({
      capacity: 1,
      onRetain: (attachment) => retainAttachmentForGarbageCollection(attachment.id),
    });

    const first = cache.acquireRetained("first", async () => ({ id: "mounted-image-1" }));
    await first.promise;
    const second = cache.acquireRetained("second", async () => ({ id: "mounted-image-2" }));
    await second.promise;

    expect(collectRetainedAttachmentIds()).toEqual(new Set(["mounted-image-1", "mounted-image-2"]));

    first.release();
    expect(collectRetainedAttachmentIds()).toEqual(new Set(["mounted-image-2"]));
    second.release();
    await expect(
      cache.acquire("cleanup", async () => {
        throw new Error("cleanup");
      }),
    ).rejects.toThrow("cleanup");
    expect(collectRetainedAttachmentIds()).toEqual(new Set());
  });

  it("rejects an invalid weight budget", () => {
    const expectInvalidMaxWeight = (maxWeight: number) =>
      expect(() =>
        createAssistantImageAcquisitionCache<string>({
          capacity: 2,
          budget: { maxWeight, getWeight: (value) => value.length },
        }),
      ).toThrow(
        "Assistant image acquisition cache budget must be a positive, finite maximum weight.",
      );

    expectInvalidMaxWeight(0);
    expectInvalidMaxWeight(-1);
    expectInvalidMaxWeight(Number.POSITIVE_INFINITY);
  });

  it("keeps a weighted entry while any consumer still retains it", async () => {
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 8,
      budget: { maxWeight: 10, getWeight: (value) => value.bytes },
      onRetain: (value) => () => released.push(value.id),
    });

    const first = cache.acquireRetained("shared", async () => ({ id: "shared", bytes: 6 }));
    const firstValue = await first.promise;
    const second = cache.acquireRetained("shared", async () => ({ id: "relocated", bytes: 6 }));
    const other = cache.acquireRetained("other", async () => ({ id: "other", bytes: 6 }));
    await other.promise;

    expect({ size: cache.size(), released }).toEqual({ size: 2, released: [] });

    first.release();
    expect({ size: cache.size(), released }).toEqual({ size: 2, released: [] });

    second.release();
    expect({ size: cache.size(), released, peekedShared: cache.peek("shared") }).toEqual({
      size: 1,
      released: ["shared"],
      peekedShared: undefined,
    });

    other.release();
    expect({ size: cache.size(), released, peekedOther: cache.peek("other") }).toEqual({
      size: 1,
      released: ["shared"],
      peekedOther: { id: "other", bytes: 6 },
    });
    expect(second.value).toBe(firstValue);
  });

  it("evicts an entry when its last consumer releases past the weight budget", async () => {
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 8,
      budget: { maxWeight: 10, getWeight: (value) => value.bytes },
      onRetain: (value) => () => released.push(value.id),
    });

    const oldest = cache.acquireRetained("oldest", async () => ({ id: "oldest", bytes: 4 }));
    const middle = cache.acquireRetained("middle", async () => ({ id: "middle", bytes: 4 }));
    const newest = cache.acquireRetained("newest", async () => ({ id: "newest", bytes: 4 }));
    await Promise.all([oldest.promise, middle.promise, newest.promise]);

    expect({ size: cache.size(), released }).toEqual({ size: 3, released: [] });

    newest.release();
    expect({ size: cache.size(), released }).toEqual({ size: 2, released: ["newest"] });

    oldest.release();
    expect({ size: cache.size(), released }).toEqual({ size: 2, released: ["newest"] });
    middle.release();
  });

  it("keeps a pending retained acquisition alive past capacity until its consumer releases", async () => {
    const located: string[] = [];
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 1,
      budget: { maxWeight: 10, getWeight: (value) => value.bytes },
      onRetain: (value) => () => released.push(value.id),
    });
    let resolveSlow: (value: WeighedValue) => void = () => undefined;
    const slowValue = new Promise<WeighedValue>((resolve) => {
      resolveSlow = resolve;
    });

    const slow = cache.acquireRetained("slow", async () => {
      located.push("slow");
      return await slowValue;
    });
    const fast = cache.acquireRetained("fast", async () => {
      located.push("fast");
      return { id: "fast", bytes: 2 };
    });
    expect(await fast.promise).toEqual({ id: "fast", bytes: 2 });
    expect({ size: cache.size(), located, released }).toEqual({
      size: 2,
      located: ["slow", "fast"],
      released: [],
    });

    resolveSlow({ id: "slow", bytes: 2 });
    expect(await slow.promise).toEqual({ id: "slow", bytes: 2 });
    expect({ size: cache.size(), released }).toEqual({ size: 2, released: [] });

    slow.release();
    expect({ size: cache.size(), released, peekedFast: cache.peek("fast") }).toEqual({
      size: 1,
      released: ["slow"],
      peekedFast: { id: "fast", bytes: 2 },
    });
    fast.release();
  });

  it("releases an oversized result that cannot fit the budget on its own", async () => {
    const located: string[] = [];
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 8,
      budget: { maxWeight: 10, getWeight: (value) => value.bytes },
      onRetain: (value) => () => released.push(value.id),
    });
    const locate = async () => {
      located.push("huge");
      return { id: "huge", bytes: 40 };
    };

    const oversized = await cache.acquire("huge", locate);
    const relocated = await cache.acquire("huge", locate);

    expect({
      oversized,
      relocated,
      located,
      released,
      size: cache.size(),
      peeked: cache.peek("huge"),
    }).toEqual({
      oversized: { id: "huge", bytes: 40 },
      relocated: { id: "huge", bytes: 40 },
      located: ["huge", "huge"],
      released: ["huge", "huge"],
      size: 0,
      peeked: undefined,
    });
  });

  it("releases a late resolution exactly once after its pending entry was evicted", async () => {
    const retained: string[] = [];
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 1,
      budget: { maxWeight: 10, getWeight: (value) => value.bytes },
      onRetain: (value) => {
        retained.push(value.id);
        return () => released.push(value.id);
      },
    });
    let resolveLate: (value: WeighedValue) => void = () => undefined;
    const late = new Promise<WeighedValue>((resolve) => {
      resolveLate = resolve;
    });

    const slow = cache.acquire("slow", async () => await late);
    const second = await cache.acquire("second", async () => ({ id: "second", bytes: 2 }));

    resolveLate({ id: "late-value", bytes: 50 });
    const awaitedLate = await slow;

    expect({
      second,
      awaitedLate,
      retained,
      released,
      size: cache.size(),
      peekedLate: cache.peek("slow"),
    }).toEqual({
      second: { id: "second", bytes: 2 },
      awaitedLate: { id: "late-value", bytes: 50 },
      retained: ["second", "late-value"],
      released: ["late-value"],
      size: 1,
      peekedLate: undefined,
    });
  });

  it("replaces the least recently used inactive entry under weight pressure", async () => {
    const located: string[] = [];
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 8,
      budget: { maxWeight: 10, getWeight: (value) => value.bytes },
      onRetain: (value) => () => released.push(value.id),
    });
    const acquire = async (id: string, bytes: number) =>
      await cache.acquire(id, async () => {
        located.push(id);
        return { id, bytes };
      });

    await acquire("a", 4);
    await acquire("b", 4);
    await acquire("a", 4);
    await acquire("c", 4);

    expect({
      located,
      released,
      size: cache.size(),
      peekedA: cache.peek("a"),
      peekedB: cache.peek("b"),
    }).toEqual({
      located: ["a", "b", "c"],
      released: ["b"],
      size: 2,
      peekedA: { id: "a", bytes: 4 },
      peekedB: undefined,
    });

    await acquire("b", 4);
    expect(located).toEqual(["a", "b", "c", "b"]);
  });

  it("serves a warm retained hit without relocating under weight pressure", async () => {
    const located: string[] = [];
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 8,
      budget: { maxWeight: 10, getWeight: (value) => value.bytes },
      onRetain: (value) => () => released.push(value.id),
    });

    const warm = cache.acquireRetained("warm", async () => {
      located.push("warm");
      return { id: "warm", bytes: 6 };
    });
    const warmValue = await warm.promise;
    const reused = cache.acquireRetained("warm", async () => {
      located.push("warm-again");
      return { id: "warm", bytes: 6 };
    });

    expect({
      reusedValue: reused.value,
      located,
      released,
      size: cache.size(),
      peeked: cache.peek("warm"),
    }).toEqual({
      reusedValue: { id: "warm", bytes: 6 },
      located: ["warm"],
      released: [],
      size: 1,
      peeked: { id: "warm", bytes: 6 },
    });
    expect(reused.value).toBe(warmValue);

    warm.release();
    reused.release();
    expect({ size: cache.size(), released }).toEqual({ size: 1, released: [] });
  });

  it("bounds browsed preview weight while active images keep their entitlement", async () => {
    const mebibyte = 1024 * 1024;
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 64,
      budget: { maxWeight: 4 * mebibyte, getWeight: (value) => value.bytes },
      onRetain: (value) => () => released.push(value.id),
    });

    const active = cache.acquireRetained("active", async () => ({
      id: "active",
      bytes: 3 * mebibyte,
    }));
    await active.promise;

    for (let index = 0; index < 40; index += 1) {
      const held = cache.acquireRetained(`browsed-${index}`, async () => ({
        id: `browsed-${index}`,
        bytes: mebibyte,
      }));
      await held.promise;
      held.release();
    }

    expect({
      size: cache.size(),
      released: released.length,
      peekedActive: cache.peek("active"),
      peekedFirstBrowsed: cache.peek("browsed-0"),
    }).toEqual({
      size: 2,
      released: 39,
      peekedActive: { id: "active", bytes: 3 * mebibyte },
      peekedFirstBrowsed: undefined,
    });

    active.release();
  });

  it("keeps weight accounting exact across repeated replacements and releases", async () => {
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 8,
      budget: { maxWeight: 10, getWeight: (value) => value.bytes },
    });
    const acquire = async (id: string, bytes: number) =>
      await cache.acquire(id, async () => ({ id, bytes }));

    const sizes: number[] = [];
    for (let cycle = 0; cycle < 12; cycle += 1) {
      await acquire(`first-${cycle}`, 6);
      await acquire(`second-${cycle}`, 6);
      sizes.push(cache.size());
    }

    const sticky = cache.acquireRetained("sticky", async () => ({ id: "sticky", bytes: 9 }));
    await sticky.promise;
    await acquire("inactive", 6);

    expect({ sizes, size: cache.size(), peekedSticky: cache.peek("sticky") }).toEqual({
      sizes: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      size: 1,
      peekedSticky: { id: "sticky", bytes: 9 },
    });

    sticky.release();
  });

  it("evicts idle entries when the active footprint alone exhausts the budget", async () => {
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 8,
      budget: { maxWeight: 10, getWeight: (value) => value.bytes },
      onRetain: (value) => () => released.push(value.id),
    });

    const active = cache.acquireRetained("active", async () => ({ id: "active", bytes: 12 }));
    const activeValue = await active.promise;
    const idle = await cache.acquire("idle", async () => ({ id: "idle", bytes: 4 }));

    expect({
      activeValue,
      idle,
      released,
      size: cache.size(),
      peekedActive: cache.peek("active"),
      peekedIdle: cache.peek("idle"),
    }).toEqual({
      activeValue: { id: "active", bytes: 12 },
      idle: { id: "idle", bytes: 4 },
      released: ["idle"],
      size: 1,
      peekedActive: { id: "active", bytes: 12 },
      peekedIdle: undefined,
    });

    active.release();
    expect({ released, size: cache.size(), peekedActive: cache.peek("active") }).toEqual({
      released: ["idle", "active"],
      size: 0,
      peekedActive: undefined,
    });
  });

  it("charges an unknown-sized entry the entire budget so idle entries cannot accumulate", async () => {
    const mebibyte = 1024 * 1024;
    const maxWeight = 16 * mebibyte;
    const released: string[] = [];
    // Mirrors the production preview budget: a known size is charged as-is, an
    // unknown one is charged the whole budget so it can never hide from the bound.
    const cache = createAssistantImageAcquisitionCache<{
      id: string;
      bytes: number | null;
    }>({
      capacity: 64,
      budget: { maxWeight, getWeight: ({ bytes }) => bytes ?? maxWeight },
      onRetain: (value) => () => released.push(value.id),
    });

    const unknown = cache.acquireRetained("unknown", async () => ({ id: "unknown", bytes: null }));
    await unknown.promise;
    const idle = await cache.acquire("idle", async () => ({ id: "idle", bytes: 1 }));

    expect({
      idle,
      released,
      size: cache.size(),
      peekedUnknown: cache.peek("unknown"),
      peekedIdle: cache.peek("idle"),
    }).toEqual({
      idle: { id: "idle", bytes: 1 },
      released: ["idle"],
      size: 1,
      peekedUnknown: { id: "unknown", bytes: null },
      peekedIdle: undefined,
    });

    // A full-budget entry still fits on its own, so releasing the consumer must
    // not revoke it; only a later weight addition forces that eviction.
    unknown.release();
    expect({ released, size: cache.size(), peekedUnknown: cache.peek("unknown") }).toEqual({
      released: ["idle"],
      size: 1,
      peekedUnknown: { id: "unknown", bytes: null },
    });

    const later = await cache.acquire("later", async () => ({ id: "later", bytes: 1 }));

    expect({
      later,
      released,
      size: cache.size(),
      peekedUnknown: cache.peek("unknown"),
      peekedLater: cache.peek("later"),
    }).toEqual({
      later: { id: "later", bytes: 1 },
      released: ["idle", "unknown"],
      size: 1,
      peekedUnknown: undefined,
      peekedLater: { id: "later", bytes: 1 },
    });
  });

  it("refuses to charge an unchargeable weight instead of corrupting the running total", async () => {
    const retained: string[] = [];
    const released: string[] = [];
    const cache = createAssistantImageAcquisitionCache<WeighedValue>({
      capacity: 8,
      budget: { maxWeight: 10, getWeight: (value) => value.bytes },
      onRetain: (value) => {
        retained.push(value.id);
        return () => released.push(value.id);
      },
    });
    const acquire = async (id: string, bytes: number) =>
      await cache.acquire(id, async () => ({ id, bytes }));

    const nan = await acquire("nan", Number.NaN);
    const negative = await acquire("negative", -1);
    const infinite = await acquire("infinite", Number.POSITIVE_INFINITY);
    const negativeInfinite = await acquire("negative-infinite", Number.NEGATIVE_INFINITY);

    expect({
      nan,
      negative,
      infinite,
      negativeInfinite,
      retained,
      released,
      size: cache.size(),
      peekedNan: cache.peek("nan"),
      peekedInfinite: cache.peek("infinite"),
    }).toEqual({
      nan: { id: "nan", bytes: Number.NaN },
      negative: { id: "negative", bytes: -1 },
      infinite: { id: "infinite", bytes: Number.POSITIVE_INFINITY },
      negativeInfinite: { id: "negative-infinite", bytes: Number.NEGATIVE_INFINITY },
      retained: ["nan", "negative", "infinite", "negative-infinite"],
      released: ["nan", "negative", "infinite", "negative-infinite"],
      size: 0,
      peekedNan: undefined,
      peekedInfinite: undefined,
    });

    // Accounting must accrue only real weights: NaN would make every later
    // comparison false and let the cache grow without bound.
    const fit = await acquire("fit", 9);
    const overflow = await acquire("overflow", 2);

    expect({
      fit,
      overflow,
      released,
      size: cache.size(),
      peekedFit: cache.peek("fit"),
      peekedOverflow: cache.peek("overflow"),
    }).toEqual({
      fit: { id: "fit", bytes: 9 },
      overflow: { id: "overflow", bytes: 2 },
      released: ["nan", "negative", "infinite", "negative-infinite", "fit"],
      size: 1,
      peekedFit: undefined,
      peekedOverflow: { id: "overflow", bytes: 2 },
    });

    // A genuinely zero-byte value is still admissible: only weights that cannot
    // be charged are refused.
    const zero = await acquire("zero", 0);

    expect({ zero, released, size: cache.size(), peekedZero: cache.peek("zero") }).toEqual({
      zero: { id: "zero", bytes: 0 },
      released: ["nan", "negative", "infinite", "negative-infinite", "fit"],
      size: 2,
      peekedZero: { id: "zero", bytes: 0 },
    });
  });
});
