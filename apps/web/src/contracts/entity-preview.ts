import { shortcodeEntities } from "@cubby/schemas/entity-roster";
import { anyShortcodeSchema, nonEmptyTuple } from "@cubby/schemas/identifiers";
import { z } from "zod";

export const ENTITY_PREVIEW_RESOURCE = "ui://cubby/entity-preview.html";
const entityShortcode = anyShortcodeSchema(nonEmptyTuple(shortcodeEntities));

export const entityCardsInput = z.strictObject({
  shortcodes: z.array(entityShortcode).min(1).max(20),
});

const fact = z.object({ label: z.string(), value: z.string() });

export const entityCardsOutput = z.object({
  items: z.array(
    z.discriminatedUnion("status", [
      z.object({
        status: z.literal("available"),
        shortcode: entityShortcode,
        name: z.string(),
        entityLabel: z.string(),
        href: z.string().url().nullable(),
        imageUrl: z.string().url().nullable(),
        facts: z.array(fact),
      }),
      z.object({
        status: z.literal("unavailable"),
        shortcode: entityShortcode,
        reason: z.enum(["unsupported_entity", "not_found"]),
      }),
    ]),
  ),
});
