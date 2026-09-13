import { z } from "zod";

export const HostTokenUsageRangeItemSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type HostTokenUsageRangeItem = z.infer<typeof HostTokenUsageRangeItemSchema>;

export const HostTokenUsageRangesSchema = z.object({
  "1h": HostTokenUsageRangeItemSchema,
  "24h": HostTokenUsageRangeItemSchema,
  "7d": HostTokenUsageRangeItemSchema,
  "30d": HostTokenUsageRangeItemSchema,
  all: HostTokenUsageRangeItemSchema,
});
export type HostTokenUsageRanges = z.infer<typeof HostTokenUsageRangesSchema>;

export const HostTokenUsageSnapshotSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  ranges: HostTokenUsageRangesSchema.nullable().optional(),
  error: z.string().nullable().optional(),
  fetchedAt: z.string(),
});
export type HostTokenUsageSnapshot = z.infer<typeof HostTokenUsageSnapshotSchema>;

export const HostTokenUsageGetSnapshotRequestSchema = z.object({
  type: z.literal("host.token_usage.get_snapshot.request"),
  requestId: z.string(),
  force: z.boolean().optional(),
});
export type HostTokenUsageGetSnapshotRequest = z.infer<
  typeof HostTokenUsageGetSnapshotRequestSchema
>;

export const HostTokenUsageGetSnapshotResponseSchema = z.object({
  type: z.literal("host.token_usage.get_snapshot.response"),
  payload: z.object({
    requestId: z.string(),
    snapshot: HostTokenUsageSnapshotSchema,
  }),
});
export type HostTokenUsageGetSnapshotResponse = z.infer<
  typeof HostTokenUsageGetSnapshotResponseSchema
>;
