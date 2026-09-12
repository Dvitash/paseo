import { useEffect } from "react";
import {
  pruneWorkspaceTerminalSnapshots,
  releaseWorkspaceTerminalSession,
  retainWorkspaceTerminalSession,
} from "@/terminal/runtime/workspace-terminal-session";

export function useWorkspaceTerminalSessionRetention(input: { scopeKey: string | null }): void {
  useEffect(() => {
    if (!input.scopeKey) {
      return;
    }

    retainWorkspaceTerminalSession({ scopeKey: input.scopeKey });
    return () => {
      releaseWorkspaceTerminalSession({ scopeKey: input.scopeKey! });
    };
  }, [input.scopeKey]);
}

/**
 * Prunes retained terminal snapshots against the workspace's known terminals.
 * `hasAuthoritativeList` distinguishes an empty list from an unknown one: until a
 * terminal payload has actually been observed, the list is not authoritative and
 * nothing is pruned.
 */
export function useWorkspaceTerminalSnapshotPruning(input: {
  scopeKey: string | null;
  knownTerminalIds: string[];
  hasAuthoritativeList: boolean;
}): void {
  const terminalIds = input.hasAuthoritativeList ? input.knownTerminalIds : null;
  useEffect(() => {
    pruneWorkspaceTerminalSnapshots({
      scopeKey: input.scopeKey,
      terminalIds,
    });
  }, [input.scopeKey, terminalIds]);
}
