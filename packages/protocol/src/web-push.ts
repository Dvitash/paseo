import { z } from "zod";

export const WebPushSubscriptionKeysSchema = z.object({
  p256dh: z.string(),
  auth: z.string(),
});

export const WebPushSubscriptionSchema = z.object({
  endpoint: z.string(),
  keys: WebPushSubscriptionKeysSchema,
  expirationTime: z.number().nullable().optional(),
  // COMPAT(pushDeviceClass): added in v0.8.0, remove optional after 2027-03-10 once old clients no longer subscribe without a device class.
  deviceClass: z.enum(["mobile", "desktop"]).optional(),
});

export type WebPushSubscriptionKeys = z.infer<typeof WebPushSubscriptionKeysSchema>;
export type WebPushSubscription = z.infer<typeof WebPushSubscriptionSchema>;
