import { z } from "zod";

export const SideChatContextSchema = z.object({
  epoch: z.string(),
  seq: z.number().int().nonnegative(),
  fingerprint: z.string(),
  capturedAt: z.string(),
  truncated: z.boolean(),
});
export type SideChatContext = z.infer<typeof SideChatContextSchema>;

export const SideChatReferenceSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["message", "tool", "diff", "selection"]),
  label: z.string().min(1).max(240),
  text: z.string().max(12_000),
  agentId: z.string().optional(),
  messageId: z.string().optional(),
  path: z.string().optional(),
});
export type SideChatReference = z.infer<typeof SideChatReferenceSchema>;
export const SideChatActionSchema = z.enum(["question", "status", "review", "steer"]);
export type SideChatAction = z.infer<typeof SideChatActionSchema>;

export const SideSteeringProposalSchema = z.object({
  id: z.string(),
  mainAgentId: z.string(),
  text: z.string(),
  createdAt: z.string(),
  delivery: z
    .object({
      messageId: z.string(),
      text: z.string(),
      status: z.enum(["pending", "delivered", "failed"]),
      updatedAt: z.string(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type SideSteeringProposal = z.infer<typeof SideSteeringProposalSchema>;

export const SideChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.string().optional(),
  action: SideChatActionSchema.optional(),
  context: SideChatContextSchema.optional(),
  references: z.array(SideChatReferenceSchema).max(4).optional(),
  proposal: SideSteeringProposalSchema.optional(),
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
  conversationId: z.string().optional(),
  createdAt: z.string().optional(),
  revision: z.number().int().nonnegative().optional(),
  phase: z
    .enum(["reading_context", "reading_files", "reading_activity", "thinking", "answering"])
    .nullable()
    .optional(),
  activity: z.string().nullable().optional(),
  context: SideChatContextSchema.nullable().optional(),
  mainContext: SideChatContextSchema.nullable().optional(),
});
export type SideChatMessage = z.infer<typeof SideChatMessageSchema>;
export type SideChatSnapshot = z.infer<typeof SideChatSnapshotSchema>;

export const SideChatSendOptionsSchema = z.object({
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  clientMessageId: z.string().min(1).max(200).optional(),
  action: SideChatActionSchema.optional(),
  references: z.array(SideChatReferenceSchema).max(4).optional(),
});
export type SideChatSendOptions = z.infer<typeof SideChatSendOptionsSchema>;

export const SideChatGetRequestSchema = z.object({
  type: z.literal("agent.side.get.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
});
export const SideChatSendRequestSchema = SideChatSendOptionsSchema.extend({
  type: z.literal("agent.side.send.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
  text: z.string().min(1).max(32_000),
});
export const SideChatStopRequestSchema = z.object({
  type: z.literal("agent.side.stop.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
});
export const SideChatSubscribeRequestSchema = z.object({
  type: z.literal("agent.side.subscribe.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
  subscribed: z.boolean(),
});
export const SideChatResetRequestSchema = z.object({
  type: z.literal("agent.side.reset.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
  conversationId: z.string().min(1).max(200),
});
export const SideChatSteerRequestSchema = z.object({
  type: z.literal("agent.side.steer.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
  proposalId: z.string().min(1).max(200),
  text: z.string().min(1).max(32_000),
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
export const SideChatSubscribeResponseSchema = z.object({
  type: z.literal("agent.side.subscribe.response"),
  payload: SideChatResponsePayloadSchema,
});
export const SideChatResetResponseSchema = z.object({
  type: z.literal("agent.side.reset.response"),
  payload: SideChatResponsePayloadSchema,
});
export const SideChatSteerResponseSchema = z.object({
  type: z.literal("agent.side.steer.response"),
  payload: SideChatResponsePayloadSchema,
});

// Updates carry changed messages only. Initial load and recovery use a complete snapshot.
export const SideChatChangedEventSchema = z.object({
  type: z.literal("agent.side.changed"),
  payload: SideChatSnapshotSchema.omit({ supportedProviders: true }),
});
export type SideChatUpdate = z.infer<typeof SideChatChangedEventSchema>["payload"];
