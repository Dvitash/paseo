import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export interface UrlValidationSuccess {
  ok: true;
  url: string;
}

export interface UrlValidationError {
  ok: false;
  message: string;
}

export type UrlValidationResult = UrlValidationSuccess | UrlValidationError;

export function validateDesktopUrl(rawUrl: string): UrlValidationResult {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        ok: false,
        message: "Desktop URL must use HTTP or HTTPS protocol.",
      };
    }
    if (parsed.username || parsed.password) {
      return {
        ok: false,
        message: "Desktop URL contains embedded credentials, which is prohibited.",
      };
    }
    if (!parsed.hostname) {
      return {
        ok: false,
        message: "Desktop URL has no hostname.",
      };
    }
    return {
      ok: true,
      url: parsed.href,
    };
  } catch {
    return {
      ok: false,
      message: "Malformed desktop browser URL.",
    };
  }
}

export const desktopStatusStartingSchema = z.object({
  status: z.literal("starting"),
});

export const desktopStatusReadySchema = z.object({
  status: z.literal("ready"),
  url: z
    .string()
    .trim()
    .min(1)
    .refine((value) => validateDesktopUrl(value).ok, {
      message: "Desktop URL must be a valid HTTP or HTTPS URL without credentials",
    }),
});

export const desktopStatusUnavailableSchema = z.object({
  status: z.literal("unavailable"),
  message: z.string(),
});

export const desktopStatusErrorSchema = z.object({
  status: z.literal("error"),
  message: z.string(),
});

export const desktopStatusOutputSchema = z.discriminatedUnion("status", [
  desktopStatusStartingSchema,
  desktopStatusReadySchema,
  desktopStatusUnavailableSchema,
  desktopStatusErrorSchema,
]);

export const desktopStatusRpc = defineRpc({
  name: "desktop.status",
  input: z.object({
    workspaceId: z.string().trim().min(1),
  }),
  output: desktopStatusOutputSchema,
});

export const desktopEventsCursorSchema = z.object({
  generation: z.string().trim().min(1),
  sequence: z.number().int().min(0),
});

export const desktopEventsRpc = defineRpc({
  name: "desktop.events",
  input: z.object({
    cursor: desktopEventsCursorSchema.nullable(),
  }),
  output: z.object({
    cursor: desktopEventsCursorSchema,
    workspaceIds: z.array(z.string().trim().min(1)),
  }),
});

export type DesktopStatus = z.infer<typeof desktopStatusOutputSchema>;
export type DesktopEventsCursor = z.infer<typeof desktopEventsCursorSchema>;
