import { z } from "zod";

export const SideChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});

export const SideChatSnapshotSchema = z.object({
  mainAgentId: z.string(),
  sideAgentId: z.string().nullable(),
  status: z.enum(["idle", "running", "error"]),
  error: z.string().nullable(),
  messages: z.array(SideChatMessageSchema),
  steeringProposal: z.string().nullable(),
  provider: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  supportedProviders: z.array(z.string()).optional(),
});

export type SideChatMessage = z.infer<typeof SideChatMessageSchema>;
export type SideChatSnapshot = z.infer<typeof SideChatSnapshotSchema>;

export const SideChatSendOptionsSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
export type SideChatSendOptions = z.infer<typeof SideChatSendOptionsSchema>;
export const SideChatGetRequestSchema = z.object({
  type: z.literal("agent.side.get.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
});

export const SideChatSendRequestSchema = z.object({
  type: z.literal("agent.side.send.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
  text: z.string().min(1).max(32_000),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

export const SideChatStopRequestSchema = z.object({
  type: z.literal("agent.side.stop.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
});

const SideChatResponsePayloadSchema = z.object({
  requestId: z.string(),
  chat: SideChatSnapshotSchema.nullable(),
  error: z.string().nullable(),
});

export const SideChatGetResponseSchema = z.object({
  type: z.literal("agent.side.get.response"),
  payload: SideChatResponsePayloadSchema,
});

export const SideChatSendResponseSchema = z.object({
  type: z.literal("agent.side.send.response"),
  payload: SideChatResponsePayloadSchema,
});

export const SideChatStopResponseSchema = z.object({
  type: z.literal("agent.side.stop.response"),
  payload: SideChatResponsePayloadSchema,
});
