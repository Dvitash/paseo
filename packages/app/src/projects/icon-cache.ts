import type { ProjectIcon } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { projectIconCacheStorage } from "./icon-cache-storage";
import type { ProjectIconTarget } from "./icon-target";

const STORAGE_KEY = "@paseo:project-icon-cache";
const CACHE_VERSION = 1;
const PERSIST_DELAY_MS = 250;
const MAX_ENTRIES = 512;
const MAX_BYTES = 4 * 1024 * 1024;
/** Fixed per-entry bookkeeping: object headers, map slot, icon object, and the payload string. */
const ENTRY_OVERHEAD_BYTES = 128;

export interface ProjectIconCacheStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

interface ProjectIconIdentity {
  serverId: string;
  projectId: string;
  revision: string;
}

type ProjectIconCacheRead = { hit: true; icon: ProjectIcon | null } | { hit: false };

interface StoredIcon extends ProjectIconIdentity {
  icon: ProjectIcon | null;
}

function keyOf(identity: ProjectIconIdentity): string {
  return JSON.stringify([identity.serverId, identity.projectId, identity.revision]);
}

/**
 * Conservative retained UTF-16 footprint, in bytes: the identity key plus its own string copies,
 * the base64 payload, the mime metadata, and fixed per-entry object overhead. Counted directly
 * rather than by serializing, so the estimate stays cheap on the hot write path.
 */
function entryBytes(entry: StoredIcon): number {
  const identityCodeUnits = entry.serverId.length + entry.projectId.length + entry.revision.length;
  const iconBytes = entry.icon ? 2 * (entry.icon.data.length + entry.icon.mimeType.length) : 0;
  return 2 * keyOf(entry).length + 2 * identityCodeUnits + iconBytes + ENTRY_OVERHEAD_BYTES;
}

function parseStoredIcon(value: unknown): StoredIcon | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.serverId !== "string" ||
    typeof entry.projectId !== "string" ||
    typeof entry.revision !== "string"
  ) {
    return null;
  }
  if (entry.icon === null) {
    return {
      serverId: entry.serverId,
      projectId: entry.projectId,
      revision: entry.revision,
      icon: null,
    };
  }
  if (!entry.icon || typeof entry.icon !== "object") return null;
  const icon = entry.icon as Record<string, unknown>;
  if (typeof icon.data !== "string" || typeof icon.mimeType !== "string") return null;
  return {
    serverId: entry.serverId,
    projectId: entry.projectId,
    revision: entry.revision,
    icon: { data: icon.data, mimeType: icon.mimeType },
  };
}

/** Owns project-icon persistence, revision matching, and negative results. */
export class ProjectIconCache {
  private readonly entries = new Map<string, StoredIcon>();
  private activeServerIds = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private bytes = 0;

  constructor(private readonly storage: ProjectIconCacheStorage) {}

  setHosts(serverIds: Iterable<string>): void {
    this.activeServerIds = new Set(serverIds);
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (!this.activeServerIds.has(entry.serverId)) {
        this.deleteEntry(key);
        changed = true;
      }
    }
    if (changed) this.schedulePersist();
  }

  async restore(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.storage.getItem(STORAGE_KEY);
    } catch {
      return;
    }
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; entries?: unknown };
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.entries)) return;
      for (const value of parsed.entries) {
        const entry = parseStoredIcon(value);
        if (!entry || !this.activeServerIds.has(entry.serverId)) continue;
        const bytes = entryBytes(entry);
        if (bytes > MAX_BYTES) continue;
        this.retain(entry, bytes);
        // Enforced per admission so a hostile payload cannot balloon the map before the caps run.
        this.enforceCaps();
      }
    } catch {
      // A corrupt cache is disposable.
    }
  }

  private read(identity: ProjectIconIdentity): ProjectIconCacheRead {
    const key = keyOf(identity);
    const entry = this.entries.get(key);
    if (!entry) return { hit: false };
    // Re-insert so Map order stays least-recently-used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { hit: true, icon: entry.icon };
  }

  private retain(entry: StoredIcon, bytes: number): void {
    const key = keyOf(entry);
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= entryBytes(previous);
    }
    this.entries.set(key, entry);
    this.bytes += bytes;
  }

  private deleteEntry(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entryBytes(entry);
  }

  private enforceCaps(): void {
    while (this.entries.size > MAX_ENTRIES || this.bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.deleteEntry(oldest);
    }
  }

  private write(identity: ProjectIconIdentity, icon: ProjectIcon | null): void {
    const entry: StoredIcon = { ...identity, icon };
    const bytes = entryBytes(entry);
    // One oversized icon must not evict the hot entries already admitted.
    if (bytes > MAX_BYTES) return;
    this.retain(entry, bytes);
    this.enforceCaps();
    this.schedulePersist();
  }

  query(
    target: ProjectIconTarget,
    supportsCustomIcons: boolean | null,
    getClient: () => DaemonClient | null,
    connected: boolean,
  ) {
    // COMPAT(projectIconCache): daemons before v0.2.7 do not expose an effective revision, so
    // their icon results remain memory-only.
    const revision = target.iconRevision ?? target.customIconRevision ?? "automatic";
    const identity: ProjectIconIdentity | null = target.iconRevision
      ? { serverId: target.serverId, projectId: target.projectId, revision: target.iconRevision }
      : null;
    const cached = identity ? this.read(identity) : { hit: false as const };
    const lookup = resolveLookup(target, supportsCustomIcons);
    let queryKey: readonly string[];
    if (!lookup) {
      queryKey = ["projectIcon", target.serverId, "pending", target.projectId];
    } else if (lookup.kind === "project") {
      queryKey = ["projectIcon", target.serverId, target.projectId, revision];
    } else {
      queryKey = ["projectIcon", target.serverId, "legacy", lookup.cwd];
    }
    return {
      queryKey,
      queryFn: async () => {
        if (!lookup) return null;
        const client = getClient();
        if (!client) return null;
        const result =
          lookup.kind === "project"
            ? await client.getProjectIcon(lookup.projectId)
            : await client.requestProjectIcon(lookup.cwd);
        if (result.error) throw new Error(result.error);
        if (identity) this.write(identity, result.icon);
        return result.icon;
      },
      enabled: Boolean(lookup && getClient() && connected),
      staleTime: Infinity,
      gcTime: 1000 * 60 * 60,
      refetchOnMount: false as const,
      refetchOnWindowFocus: false as const,
      refetchOnReconnect: false as const,
      ...(cached.hit ? { initialData: cached.icon } : {}),
    };
  }

  reconcileServerId(oldServerId: string, newServerId: string): void {
    // Snapshot the keys: rekeying appends and collisions remove keys mid-walk.
    const keys = Array.from(this.entries.keys());
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry || entry.serverId !== oldServerId) continue;
      const reconciled: StoredIcon = { ...entry, serverId: newServerId };
      this.deleteEntry(key);
      this.retain(reconciled, entryBytes(reconciled));
    }
    if (this.activeServerIds.delete(oldServerId)) this.activeServerIds.add(newServerId);
    // Longer keys cost more: a rekey can push the map past the byte budget on its own.
    this.enforceCaps();
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const payload = JSON.stringify({ version: CACHE_VERSION, entries: [...this.entries.values()] });
    const write = this.writeQueue
      .catch(() => undefined)
      .then(() => this.storage.setItem(STORAGE_KEY, payload));
    this.writeQueue = write;
    await write.catch(() => undefined);
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DELAY_MS);
  }
}

export const projectIconCache = new ProjectIconCache(projectIconCacheStorage);

function resolveLookup(
  target: Pick<ProjectIconTarget, "projectId" | "iconWorkingDir">,
  supportsCustomIcons: boolean | null,
): { kind: "project"; projectId: string } | { kind: "legacy"; cwd: string } | null {
  if (supportsCustomIcons === null) return null;
  return supportsCustomIcons
    ? { kind: "project", projectId: target.projectId }
    : { kind: "legacy", cwd: target.iconWorkingDir };
}
