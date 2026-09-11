import { z } from "zod";
import { SideChatSnapshotSchema } from "@getpaseo/protocol/side";

export type { SideChatMessage, SideChatSnapshot } from "@getpaseo/protocol/side";

export const SideContextCheckpointSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
  recentRows: z.array(z.object({ seq: z.number().int(), hash: z.string() })).optional(),
});
export type SideContextCheckpoint = z.infer<typeof SideContextCheckpointSchema>;

export const StoredSideChatRecordSchema = SideChatSnapshotSchema.omit({
  supportedProviders: true,
}).extend({
  checkpoint: SideContextCheckpointSchema.nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  /** True when the side agent was forked from the main native session. */
  forked: z.boolean().nullable().optional(),
  /** Completion time of the last side turn; drives fork reuse freshness. */
  lastTurnCompletedAt: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type StoredSideChatRecord = z.infer<typeof StoredSideChatRecordSchema>;
