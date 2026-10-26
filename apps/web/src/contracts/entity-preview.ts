import { z } from "zod";

export const ENTITY_PREVIEW_RESOURCE = "ui://cubby/entity-preview.html";

export const entityCardsInput = z.strictObject({
  shortcodes: z.array(z.string().trim().min(1).max(40)).min(1).max(20),
});

const fact = z.object({ label: z.string(), value: z.string() });

export const entityCardsOutput = z.object({
  items: z.array(
    z.discriminatedUnion("status", [
      z.object({
        status: z.literal("available"),
        shortcode: z.string(),
        name: z.string(),
        entityLabel: z.string(),
        href: z.string().url().nullable(),
        imageUrl: z.string().url().nullable(),
        facts: z.array(fact),
      }),
      z.object({
        status: z.literal("unavailable"),
        shortcode: z.string(),
        reason: z.enum([
          "invalid_shortcode",
          "unsupported_entity",
          "not_found",
        ]),
      }),
    ]),
  ),
});
