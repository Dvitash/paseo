import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { SideChatActionSchema, SideChatReferenceSchema } from "@getpaseo/protocol/side";
import type { SideChatSnapshot } from "@getpaseo/protocol/side";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const SubmissionSchema = z.object({
  id: z.string(),
  text: z.string(),
  action: SideChatActionSchema,
  provider: z.string(),
  model: z.string().nullable(),
  references: z.array(SideChatReferenceSchema),
  state: z.enum(["sending", "failed"]),
  error: z.string().nullable(),
});
const DraftSchema = z.object({
  text: z.string(),
  references: z.array(SideChatReferenceSchema),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  submission: SubmissionSchema.nullable(),
});
export type SideDraft = z.infer<typeof DraftSchema>;
export type SideSubmission = z.infer<typeof SubmissionSchema>;
const PersistedSchema = z.object({
  drafts: z.record(z.string(), DraftSchema),
  pins: z.record(z.string(), z.string().nullable()),
  lastMain: z.record(z.string(), z.string()),
  proposalDrafts: z.record(z.string(), z.string()),
});
interface SideWorkspaceState extends z.infer<typeof PersistedSchema> {
  updateDraft: (key: string, patch: Partial<SideDraft>) => void;
  pin: (workspaceKey: string, agentId: string | null) => void;
  rememberMain: (workspaceKey: string, agentId: string) => void;
  editProposal: (key: string, text: string) => void;
  reconcile: (key: string, snapshot: SideChatSnapshot) => void;
}
export const EMPTY_SIDE_DRAFT: SideDraft = {
  text: "",
  references: [],
  provider: null,
  model: null,
  submission: null,
};
export function sideSessionKey(serverId: string, mainAgentId: string): string {
  return JSON.stringify([serverId, mainAgentId]);
}
export const useSideWorkspaceStore = create<SideWorkspaceState>()(
  persist(
    (set) => ({
      drafts: {},
      pins: {},
      lastMain: {},
      proposalDrafts: {},
      updateDraft: (key, patch) =>
        set((state) => ({
          drafts: {
            ...state.drafts,
            [key]: { ...EMPTY_SIDE_DRAFT, ...state.drafts[key], ...patch },
          },
        })),
      pin: (key, agentId) => set((state) => ({ pins: { ...state.pins, [key]: agentId } })),
      rememberMain: (key, agentId) =>
        set((state) =>
          state.lastMain[key] === agentId
            ? state
            : { lastMain: { ...state.lastMain, [key]: agentId } },
        ),
      editProposal: (key, text) =>
        set((state) => ({ proposalDrafts: { ...state.proposalDrafts, [key]: text } })),
      reconcile: (key, snapshot) =>
        set((state) => {
          const draft = state.drafts[key];
          const submission = draft?.submission;
          if (!submission || !snapshot.messages.some((message) => message.id === submission.id))
            return state;
          // Never erase text the user started writing while the previous request was in flight.
          const clearText = submission.action === "question" && draft.text === submission.text;
          return {
            drafts: {
              ...state.drafts,
              [key]: {
                ...draft,
                text: clearText ? "" : draft.text,
                references: clearText ? [] : draft.references,
                submission: null,
              },
            },
          };
        }),
    }),
    {
      name: "side-workspace-state",
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, PersistedSchema),
      partialize: ({ drafts, pins, lastMain, proposalDrafts }) => ({
        drafts,
        pins,
        lastMain,
        proposalDrafts,
      }),
    },
  ),
);

export function isNearSideBottom(offset: number, height: number, contentHeight: number): boolean {
  return contentHeight - offset - height <= 72;
}
export function sideContextLabel(snapshot: SideChatSnapshot | undefined): string {
  const context = snapshot?.context;
  if (!context) return "Main context is read when you ask";
  const latest = snapshot.mainContext;
  if (latest && (latest.epoch !== context.epoch || latest.fingerprint !== context.fingerprint))
    return `Main has newer activity · answer through #${context.seq}`;
  const time = new Date(context.capturedAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const coverage = context.truncated ? " · abridged" : "";
  return `Read through #${context.seq} · ${time}${coverage}`;
}
export const SIDE_PHASE_LABELS = {
  reading_context: "Reading main activity…",
  reading_files: "Inspecting files…",
  reading_activity: "Checking live activity…",
  thinking: "Thinking…",
  answering: "Generating answer…",
} as const;
