import type { TerminalState } from "@getpaseo/protocol/messages";

export interface WorkspaceTerminalSnapshots {
  get: (input: { terminalId: string }) => TerminalState | null;
  set: (input: { terminalId: string; state: TerminalState }) => void;
  clear: (input: { terminalId: string }) => void;
  prune: (input: { terminalIds: string[] }) => void;
}

export interface WorkspaceTerminalSession {
  scopeKey: string;
  snapshots: WorkspaceTerminalSnapshots;
}

/**
 * The workspace terminal panes and the workspace screen that keeps their
 * snapshots alive must agree on exactly one key. It is the workspace directory,
 * not the workspace id: a pane only ever receives `serverId` and `cwd`.
 */
export function buildWorkspaceTerminalSessionKey(input: { serverId: string; cwd: string }): string {
  return `${input.serverId}:${input.cwd}`;
}

interface WorkspaceTerminalSessionRecord {
  snapshotByTerminalId: Map<string, TerminalState>;
  session: WorkspaceTerminalSession;
}

const sessionsByScopeKey = new Map<string, WorkspaceTerminalSessionRecord>();
const refCountByScopeKey = new Map<string, number>();

function createSnapshots(input: {
  snapshotByTerminalId: Map<string, TerminalState>;
}): WorkspaceTerminalSnapshots {
  return {
    get: ({ terminalId }) => input.snapshotByTerminalId.get(terminalId) ?? null,
    set: ({ terminalId, state }) => {
      input.snapshotByTerminalId.set(terminalId, state);
    },
    clear: ({ terminalId }) => {
      input.snapshotByTerminalId.delete(terminalId);
    },
    prune: ({ terminalIds }) => {
      const terminalIdSet = new Set(terminalIds);
      for (const terminalId of Array.from(input.snapshotByTerminalId.keys())) {
        if (!terminalIdSet.has(terminalId)) {
          input.snapshotByTerminalId.delete(terminalId);
        }
      }
    },
  };
}

export function getWorkspaceTerminalSession(input: { scopeKey: string }): WorkspaceTerminalSession {
  const existing = sessionsByScopeKey.get(input.scopeKey);
  if (existing) {
    return existing.session;
  }

  const snapshotByTerminalId = new Map<string, TerminalState>();
  const session: WorkspaceTerminalSession = {
    scopeKey: input.scopeKey,
    snapshots: createSnapshots({
      snapshotByTerminalId,
    }),
  };

  sessionsByScopeKey.set(input.scopeKey, {
    snapshotByTerminalId,
    session,
  });
  return session;
}

/**
 * Drops snapshots for terminals the workspace no longer lists. `terminalIds` is
 * `null` while the list is not authoritative (never fetched, query disabled, or
 * host disconnected): an unknown list is not an empty list. Pruning never
 * creates a session, so a workspace that holds no snapshots stays absent.
 */
export function pruneWorkspaceTerminalSnapshots(input: {
  scopeKey: string | null;
  terminalIds: string[] | null;
}): void {
  if (!input.scopeKey || input.terminalIds === null) {
    return;
  }
  const record = sessionsByScopeKey.get(input.scopeKey);
  if (!record) {
    return;
  }
  record.session.snapshots.prune({ terminalIds: input.terminalIds });
}

export function retainWorkspaceTerminalSession(input: { scopeKey: string }): void {
  const current = refCountByScopeKey.get(input.scopeKey) ?? 0;
  refCountByScopeKey.set(input.scopeKey, current + 1);
}

export function releaseWorkspaceTerminalSession(input: { scopeKey: string }): void {
  const current = refCountByScopeKey.get(input.scopeKey) ?? 0;
  if (current > 1) {
    refCountByScopeKey.set(input.scopeKey, current - 1);
    return;
  }
  refCountByScopeKey.delete(input.scopeKey);
  sessionsByScopeKey.delete(input.scopeKey);
}
