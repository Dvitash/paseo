import { z } from "zod";

export const WebPushSubscriptionKeysSchema = z.object({
  p256dh: z.string(),
  auth: z.string(),
});

export const WebPushSubscriptionSchema = z.object({
  endpoint: z.string(),
  keys: WebPushSubscriptionKeysSchema,
  expirationTime: z.number().nullable().optional(),
});

export type WebPushSubscriptionKeys = z.infer<typeof WebPushSubscriptionKeysSchema>;
export type WebPushSubscription = z.infer<typeof WebPushSubscriptionSchema>;
