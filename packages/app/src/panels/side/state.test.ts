import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_SIDE_DRAFT,
  isNearSideBottom,
  sideContextLabel,
  sideSessionKey,
  useSideWorkspaceStore,
} from "./state";
import { resolveEffectiveSideProvider } from "../side-panel-state";
import type { SideChatSnapshot } from "@getpaseo/protocol/side";
vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: async (key: string) => storage.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        storage.set(key, value);
      },
      removeItem: async (key: string) => {
        storage.delete(key);
      },
    },
  };
});

const snapshot: SideChatSnapshot = {
  mainAgentId: "a",
  sideAgentId: null,
  status: "idle",
  error: null,
  messages: [{ id: "sent", role: "user", text: "Question" }],
  steeringProposal: null,
};
beforeEach(() =>
  useSideWorkspaceStore.setState({ drafts: {}, pins: {}, lastMain: {}, proposalDrafts: {} }),
);
describe("Side workspace continuity", () => {
  it("keeps drafts, model preferences, and references isolated by host and main", () => {
    const store = useSideWorkspaceStore.getState();
    store.updateDraft(sideSessionKey("host1", "a"), { text: "First draft", provider: "codex" });
    store.updateDraft(sideSessionKey("host1", "b"), { text: "Second draft" });
    store.updateDraft(sideSessionKey("host2", "a"), { text: "Other host" });
    expect(useSideWorkspaceStore.getState().drafts[sideSessionKey("host1", "a")]).toMatchObject({
      text: "First draft",
      provider: "codex",
    });
    expect(Object.keys(useSideWorkspaceStore.getState().drafts)).toHaveLength(3);
  });
  it("reconciles accepted optimistic sends without deleting a newer draft", () => {
    const key = sideSessionKey("host", "a");
    const submission = {
      id: "sent",
      text: "Question",
      action: "question" as const,
      references: [],
      provider: "codex",
      model: null,
      state: "sending" as const,
      error: null,
    };
    const store = useSideWorkspaceStore.getState();
    store.updateDraft(key, { text: "New draft", submission });
    store.reconcile(key, snapshot);
    expect(useSideWorkspaceStore.getState().drafts[key]).toMatchObject({
      text: "New draft",
      submission: null,
    });
    store.updateDraft(key, { text: "Question", submission });
    store.reconcile(key, snapshot);
    expect(useSideWorkspaceStore.getState().drafts[key]).toMatchObject({
      text: "",
      submission: null,
    });
  });
  it("keeps a draft while using a status shortcut", () => {
    const key = sideSessionKey("host", "a");
    const store = useSideWorkspaceStore.getState();
    store.updateDraft(key, {
      ...EMPTY_SIDE_DRAFT,
      text: "Unsent",
      submission: {
        id: "sent",
        text: "Status update",
        action: "status",
        references: [],
        provider: "claude",
        model: null,
        state: "sending",
        error: null,
      },
    });
    store.reconcile(key, snapshot);
    expect(useSideWorkspaceStore.getState().drafts[key].text).toBe("Unsent");
  });
  it("uses the user-selected provider before main defaults and preserves started providers", () => {
    const input = {
      selectedProvider: "codex",
      mainAgentProvider: "claude",
      supportedProviders: ["claude", "codex"],
    };
    expect(resolveEffectiveSideProvider(input)).toBe("codex");
    expect(resolveEffectiveSideProvider({ ...input, activeSideProvider: "claude" })).toBe("claude");
    expect(resolveEffectiveSideProvider({ ...input, supportedProviders: ["claude"] })).toBeNull();
  });
  it("does not call a context current when a main row changes in place", () => {
    const context = {
      epoch: "epoch",
      seq: 8,
      fingerprint: "before",
      capturedAt: "2026-09-16T01:00:00Z",
      truncated: true,
    };
    expect(
      sideContextLabel({ ...snapshot, context, mainContext: { ...context, fingerprint: "after" } }),
    ).toContain("newer activity");
    expect(sideContextLabel({ ...snapshot, context, mainContext: context })).toContain("abridged");
    expect(sideContextLabel(undefined)).toContain("when you ask");
  });
  it("follows only within the near-bottom threshold", () => {
    expect(isNearSideBottom(0, 300, 1000)).toBe(false);
    expect(isNearSideBottom(660, 300, 1000)).toBe(true);
  });
});
