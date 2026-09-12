import { describe, expect, it } from "vitest";

import type { TerminalState } from "@getpaseo/protocol/messages";
import {
  buildWorkspaceTerminalSessionKey,
  getWorkspaceTerminalSession,
  pruneWorkspaceTerminalSnapshots,
  releaseWorkspaceTerminalSession,
  retainWorkspaceTerminalSession,
} from "./workspace-terminal-session";

function terminalState(char: string): TerminalState {
  return {
    rows: 1,
    cols: 1,
    grid: [[{ char }]],
    scrollback: [],
    cursor: { row: 0, col: 0 },
  };
}

describe("workspace-terminal-session", () => {
  it("returns the same workspace session instance for the same scope", () => {
    const first = getWorkspaceTerminalSession({
      scopeKey: "workspace-a",
    });
    const second = getWorkspaceTerminalSession({
      scopeKey: "workspace-a",
    });

    expect(second).toBe(first);
  });

  it("preserves snapshots across repeated lookups", () => {
    const first = getWorkspaceTerminalSession({
      scopeKey: "workspace-snapshots",
    });
    first.snapshots.set({ terminalId: "term-1", state: terminalState("A") });

    const second = getWorkspaceTerminalSession({
      scopeKey: "workspace-snapshots",
    });

    expect(second.snapshots.get({ terminalId: "term-1" })).toEqual(terminalState("A"));
  });

  it("evicts workspace terminal session state when the retain count returns to zero", () => {
    const scopeKey = "workspace-release";
    const first = getWorkspaceTerminalSession({
      scopeKey,
    });
    first.snapshots.set({ terminalId: "term-1", state: terminalState("A") });

    retainWorkspaceTerminalSession({ scopeKey });
    releaseWorkspaceTerminalSession({ scopeKey });

    const second = getWorkspaceTerminalSession({
      scopeKey,
    });

    expect(second).not.toBe(first);
    expect(second.snapshots.get({ terminalId: "term-1" })).toBeNull();
  });

  it("keys the workspace session the same way the terminal panes do", () => {
    const scopeKey = buildWorkspaceTerminalSessionKey({
      serverId: "host-1",
      cwd: "/repo/worktree",
    });
    const session = getWorkspaceTerminalSession({ scopeKey });
    session.snapshots.set({ terminalId: "term-1", state: terminalState("A") });

    pruneWorkspaceTerminalSnapshots({ scopeKey, terminalIds: ["term-1"] });

    const restored = getWorkspaceTerminalSession({ scopeKey });
    expect(restored.snapshots.get({ terminalId: "term-1" })).toEqual(terminalState("A"));
  });

  it("keeps snapshots for live terminals and clears the ones the list dropped", () => {
    const scopeKey = "workspace-prune-dead";
    const session = getWorkspaceTerminalSession({ scopeKey });
    session.snapshots.set({ terminalId: "term-live", state: terminalState("A") });
    session.snapshots.set({ terminalId: "term-dead", state: terminalState("B") });

    pruneWorkspaceTerminalSnapshots({ scopeKey, terminalIds: ["term-live"] });

    expect(session.snapshots.get({ terminalId: "term-live" })).toEqual(terminalState("A"));
    expect(session.snapshots.get({ terminalId: "term-dead" })).toBeNull();
  });

  it("clears every snapshot when the authoritative list is empty", () => {
    const scopeKey = "workspace-prune-empty";
    const session = getWorkspaceTerminalSession({ scopeKey });
    session.snapshots.set({ terminalId: "term-1", state: terminalState("A") });
    session.snapshots.set({ terminalId: "term-2", state: terminalState("B") });

    pruneWorkspaceTerminalSnapshots({ scopeKey, terminalIds: [] });

    expect(session.snapshots.get({ terminalId: "term-1" })).toBeNull();
    expect(session.snapshots.get({ terminalId: "term-2" })).toBeNull();
  });

  it("keeps snapshots when the terminal list is unknown", () => {
    const scopeKey = "workspace-prune-unknown";
    const session = getWorkspaceTerminalSession({ scopeKey });
    session.snapshots.set({ terminalId: "term-1", state: terminalState("A") });

    pruneWorkspaceTerminalSnapshots({ scopeKey, terminalIds: null });

    expect(session.snapshots.get({ terminalId: "term-1" })).toEqual(terminalState("A"));
  });

  it("leaves sessions without a scope key untouched", () => {
    const session = getWorkspaceTerminalSession({ scopeKey: "workspace-prune-no-scope" });
    session.snapshots.set({ terminalId: "term-1", state: terminalState("A") });

    pruneWorkspaceTerminalSnapshots({ scopeKey: null, terminalIds: [] });

    expect(session.snapshots.get({ terminalId: "term-1" })).toEqual(terminalState("A"));
  });

  it("keeps a sibling workspace's snapshots when another workspace prunes", () => {
    const prunedSession = getWorkspaceTerminalSession({ scopeKey: "workspace-sibling-a" });
    const siblingSession = getWorkspaceTerminalSession({ scopeKey: "workspace-sibling-b" });
    prunedSession.snapshots.set({ terminalId: "term-1", state: terminalState("A") });
    siblingSession.snapshots.set({ terminalId: "term-2", state: terminalState("B") });

    pruneWorkspaceTerminalSnapshots({ scopeKey: "workspace-sibling-a", terminalIds: [] });

    expect(prunedSession.snapshots.get({ terminalId: "term-1" })).toBeNull();
    expect(siblingSession.snapshots.get({ terminalId: "term-2" })).toEqual(terminalState("B"));
  });

  it("does not accumulate snapshots across repeated terminal churn", () => {
    const scopeKey = "workspace-churn";
    const session = getWorkspaceTerminalSession({ scopeKey });
    const churnedTerminalIds: string[] = [];

    for (let index = 0; index < 50; index += 1) {
      const liveTerminalId = `term-${index}`;
      session.snapshots.set({ terminalId: liveTerminalId, state: terminalState("X") });
      pruneWorkspaceTerminalSnapshots({ scopeKey, terminalIds: [liveTerminalId] });
      churnedTerminalIds.push(liveTerminalId);
    }

    const liveTerminalId = churnedTerminalIds[churnedTerminalIds.length - 1];
    for (const terminalId of churnedTerminalIds) {
      const expected = terminalId === liveTerminalId ? terminalState("X") : null;
      expect(session.snapshots.get({ terminalId })).toEqual(expected);
    }
  });
});
