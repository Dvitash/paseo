import type { SideChatSnapshot, SideChatUpdate } from "@getpaseo/protocol/side";

interface SideListener {
  next: (snapshot: SideChatSnapshot) => void;
  error: (error: Error) => void;
}
interface SideEntry {
  listeners: Set<SideListener>;
  snapshot: SideChatSnapshot | null;
  generation: number;
  pending: Promise<void> | null;
  buffered: SideChatUpdate[];
}
interface SideSubscriptionTransport {
  connected: () => boolean;
  request: (mainAgentId: string, subscribed: boolean) => Promise<SideChatSnapshot>;
}

/** A delta is a set of message upserts, never a replacement transcript. */
export function mergeSideChatUpdate(
  snapshot: SideChatSnapshot,
  update: SideChatUpdate,
): SideChatSnapshot | null {
  if (
    snapshot.mainAgentId !== update.mainAgentId ||
    snapshot.conversationId !== update.conversationId
  )
    return null;
  const current = snapshot.revision ?? 0;
  const incoming = update.revision ?? 0;
  if (incoming <= current) return snapshot;
  if (incoming !== current + 1) return null;
  const changed = new Map(update.messages.map((message) => [message.id, message]));
  const messages = snapshot.messages.map((message) => {
    const replacement = changed.get(message.id);
    changed.delete(message.id);
    return replacement ?? message;
  });
  messages.push(...changed.values());
  return { ...snapshot, ...update, messages };
}

export class SideChatSubscriptions {
  private readonly entries = new Map<string, SideEntry>();

  constructor(private readonly transport: SideSubscriptionTransport) {}

  subscribe(
    mainAgentId: string,
    next: SideListener["next"],
    error: SideListener["error"],
  ): () => void {
    let entry = this.entries.get(mainAgentId);
    if (!entry) {
      entry = { listeners: new Set(), snapshot: null, generation: 0, pending: null, buffered: [] };
      this.entries.set(mainAgentId, entry);
    }
    const listener = { next, error };
    entry.listeners.add(listener);
    if (entry.snapshot) next(entry.snapshot);
    void this.refresh(mainAgentId);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0) return;
      entry.generation++;
      this.entries.delete(mainAgentId);
      if (this.transport.connected()) {
        // A released subscription has no consumer to report an unsubscribe failure to.
        void this.transport.request(mainAgentId, false).catch(() => undefined);
      }
    };
  }

  refresh(mainAgentId: string): Promise<void> {
    const entry = this.entries.get(mainAgentId);
    if (!entry || !this.transport.connected()) return Promise.resolve();
    if (entry.pending) return entry.pending;
    const generation = ++entry.generation;
    entry.buffered = [];
    entry.pending = this.readSnapshot(mainAgentId, entry, generation);
    return entry.pending;
  }

  private async readSnapshot(
    mainAgentId: string,
    entry: SideEntry,
    generation: number,
  ): Promise<void> {
    try {
      const snapshot = await this.transport.request(mainAgentId, true);
      if (entry.generation !== generation) return;
      let next = snapshot;
      let needsRefresh = false;
      for (const update of entry.buffered) {
        if (
          update.conversationId === next.conversationId &&
          (update.revision ?? 0) <= (next.revision ?? 0)
        )
          continue;
        const merged = mergeSideChatUpdate(next, update);
        if (!merged) {
          needsRefresh = true;
          break;
        }
        next = merged;
      }
      entry.snapshot = next;
      entry.buffered = [];
      entry.pending = null;
      for (const listener of entry.listeners) listener.next(next);
      if (needsRefresh) void this.refresh(mainAgentId);
    } catch (cause) {
      if (entry.generation !== generation) return;
      entry.pending = null;
      entry.buffered = [];
      const error = cause instanceof Error ? cause : new Error(String(cause));
      for (const listener of entry.listeners) listener.error(error);
    }
  }

  receive(update: SideChatUpdate): void {
    const entry = this.entries.get(update.mainAgentId);
    if (!entry) return;
    if (entry.pending) {
      // The snapshot will fill a gap if a very busy stream exceeds this bounded buffer.
      entry.buffered.push(update);
      if (entry.buffered.length > 128) entry.buffered.shift();
      return;
    }
    const merged = entry.snapshot && mergeSideChatUpdate(entry.snapshot, update);
    if (!merged) {
      void this.refresh(update.mainAgentId);
      return;
    }
    if (merged === entry.snapshot) return;
    entry.snapshot = merged;
    for (const listener of entry.listeners) listener.next(merged);
  }

  pause(): void {
    for (const entry of this.entries.values()) {
      entry.generation++;
      entry.pending = null;
      entry.buffered = [];
    }
  }

  restore(): void {
    for (const mainAgentId of this.entries.keys()) void this.refresh(mainAgentId);
  }

  clear(): void {
    this.pause();
    this.entries.clear();
  }
}
