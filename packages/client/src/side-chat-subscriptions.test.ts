import { describe, expect, it, vi } from "vitest";
import type { SideChatSnapshot, SideChatUpdate } from "@getpaseo/protocol/side";
import { SideChatSubscriptions, mergeSideChatUpdate } from "./side-chat-subscriptions.js";

const snapshot = (revision = 1): SideChatSnapshot => ({
  mainAgentId: "main",
  sideAgentId: "side",
  conversationId: "chat",
  status: "idle",
  error: null,
  steeringProposal: null,
  revision,
  messages: [{ id: "old", role: "user", text: "Keep this" }],
  supportedProviders: ["omp"],
});
const update = (revision: number, text = "Answer"): SideChatUpdate => ({
  ...snapshot(revision),
  messages: [{ id: "answer", role: "assistant", text }],
});
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe("Side incremental subscriptions", () => {
  it("upserts messages without losing history and ignores stale revisions", () => {
    const merged = mergeSideChatUpdate(snapshot(), update(2));
    expect(merged?.messages.map((message) => message.id)).toEqual(["old", "answer"]);
    expect(merged?.supportedProviders).toEqual(["omp"]);
    expect(merged && mergeSideChatUpdate(merged, update(2, "obsolete"))).toBe(merged);
    expect(
      merged && mergeSideChatUpdate(merged, update(3, "Longer answer"))?.messages.at(-1)?.text,
    ).toBe("Longer answer");
  });
  it("requires a full snapshot for a gap, different session, or conversation reset", () => {
    expect(mergeSideChatUpdate(snapshot(), update(5))).toBeNull();
    expect(mergeSideChatUpdate(snapshot(), { ...update(2), mainAgentId: "other" })).toBeNull();
    expect(mergeSideChatUpdate(snapshot(), { ...update(2), conversationId: "new" })).toBeNull();
  });
  it("buffers events racing with initial load and shares one subscription", async () => {
    let resolve!: (chat: SideChatSnapshot) => void;
    const request = vi.fn(
      () =>
        new Promise<SideChatSnapshot>((done) => {
          resolve = done;
        }),
    );
    const subscriptions = new SideChatSubscriptions({ connected: () => true, request });
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscriptions.subscribe("main", a, vi.fn());
    const offB = subscriptions.subscribe("main", b, vi.fn());
    subscriptions.receive(update(2));
    resolve(snapshot());
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    expect(a.mock.lastCall?.[0].messages).toHaveLength(2);
    expect(b.mock.lastCall?.[0].revision).toBe(2);
    offA();
    expect(request).toHaveBeenCalledTimes(1);
    offB();
    expect(request).toHaveBeenLastCalledWith("main", false);
  });
  it("resumes an idle conversation after a host restart even when revisions reset", async () => {
    let current = snapshot(10);
    const request = vi.fn(async () => current);
    const subscriptions = new SideChatSubscriptions({ connected: () => true, request });
    const listener = vi.fn();
    subscriptions.subscribe("main", listener, vi.fn());
    await tick();
    subscriptions.pause();
    current = { ...snapshot(1), status: "running" };
    subscriptions.restore();
    await tick();
    expect(listener.mock.lastCall?.[0].status).toBe("running");
    expect(listener.mock.lastCall?.[0].revision).toBe(1);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("recovers missed events once, including same-sequence main context changes", async () => {
    const request = vi.fn(async () => snapshot());
    const subscriptions = new SideChatSubscriptions({ connected: () => true, request });
    const listener = vi.fn();
    subscriptions.subscribe("main", listener, vi.fn());
    await tick();
    request.mockResolvedValue({
      ...snapshot(8),
      messages: [...snapshot().messages, ...update(8).messages],
    });
    subscriptions.receive(update(8));
    await tick();
    expect(request).toHaveBeenCalledTimes(2);
    expect(listener.mock.lastCall?.[0].messages).toHaveLength(2);
  });
  it("does not poll when idle and refreshes explicitly on foreground", async () => {
    const request = vi.fn(async () => snapshot());
    const subscriptions = new SideChatSubscriptions({ connected: () => true, request });
    subscriptions.subscribe("main", vi.fn(), vi.fn());
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
    await subscriptions.refresh("main");
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("reports connection failures, then allows a manual retry", async () => {
    const request = vi.fn(async () => snapshot());
    request.mockRejectedValueOnce(new Error("offline"));
    const subscriptions = new SideChatSubscriptions({ connected: () => true, request });
    const listener = vi.fn();
    const error = vi.fn();
    subscriptions.subscribe("main", listener, error);
    await tick();
    expect(error.mock.lastCall?.[0].message).toBe("offline");
    await subscriptions.refresh("main");
    expect(listener).toHaveBeenCalledOnce();
  });
  it("ignores a superseded connection response", async () => {
    let resolve!: (chat: SideChatSnapshot) => void;
    const request = vi.fn(
      () =>
        new Promise<SideChatSnapshot>((done) => {
          resolve = done;
        }),
    );
    const subscriptions = new SideChatSubscriptions({ connected: () => true, request });
    const listener = vi.fn();
    subscriptions.subscribe("main", listener, vi.fn());
    subscriptions.pause();
    resolve(snapshot(100));
    await tick();
    expect(listener).not.toHaveBeenCalled();
  });
});
