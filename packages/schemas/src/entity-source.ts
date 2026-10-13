import { z } from "zod";

import { auditChannelSchema } from "./context";
import { ENTITY_SOURCE_QUOTE_MAX } from "./child-tables/modules";
import { entityRefSchema } from "./entity";
import { shortcodeEntities } from "./entity-manifest";
import {
  anyShortcodeSchema,
  deviceShortcode,
  nonEmptyTuple,
  runShortcode,
} from "./identifiers";

const sourceEntityCode = anyShortcodeSchema(nonEmptyTuple(shortcodeEntities));

export const entitySourceTarget = entityRefSchema.extend({
  entityId: sourceEntityCode,
  name: z.string().nullable(),
  deleted: z.boolean(),
});

const sourceFields = {
  sourceEntity: sourceEntityCode
    .optional()
    .describe(
      "Cubby record where the fact was seen; use its shortcode instead of a Cubby URL.",
    ),
  url: z
    .url()
    .max(2048)
    .optional()
    .describe("Page or file the fact was seen on."),
  quote: z
    .string()
    .trim()
    .min(1)
    .max(ENTITY_SOURCE_QUOTE_MAX)
    .optional()
    .describe("The relevant quoted text, verbatim."),
  observedAt: z.coerce
    .date()
    .optional()
    .describe("When the fact was observed; omit when unknown."),
  selectedVariant: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("The size, color, or pack variant the page had selected."),
};
const hasTargetOrQuote = (source: {
  url?: string;
  sourceEntity?: string;
  quote?: string;
}) =>
  source.url !== undefined ||
  source.sourceEntity !== undefined ||
  source.quote !== undefined;
const targetOrQuote = {
  message: "A source needs a url, sourceEntity or quote",
};
const oneTarget = (source: { url?: string; sourceEntity?: string }) =>
  source.url === undefined || source.sourceEntity === undefined;
const exclusiveTarget = {
  message: "Use either url or sourceEntity for a source",
};

/**
 * One Source a caller supplies with a write (terminology "Source"): where a fact
 * about the entity was seen. The recorder is never input; the kernel takes it
 * from the authenticated actor.
 */
export const entitySourceInput = z
  .strictObject({
    fieldPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Writable field this source supports (for example `model`); omit for a source about the record as a whole.",
      ),
    ...sourceFields,
  })
  .refine(hasTargetOrQuote, targetOrQuote)
  .refine(oneTarget, exclusiveTarget);
export type EntitySourceInput = z.infer<typeof entitySourceInput>;

export const entitySourceInputs = z
  .array(entitySourceInput)
  .max(50)
  .describe(
    "Where the written facts were seen. Stored with the write in the same transaction.",
  );

/** A source about the whole record (image attach): no field scope. */
export const entityRecordSourceInputs = z
  .array(
    z
      .strictObject(sourceFields)
      .refine(hasTargetOrQuote, targetOrQuote)
      .refine(oneTarget, exclusiveTarget),
  )
  .max(50)
  .describe("Where this file was found; recorded on the target record.");

export const entitySourceRead = z.object({
  fieldPath: z.string().nullable(),
  sourceEntity: entitySourceTarget.nullable(),
  url: z.string().nullable(),
  quote: z.string().nullable(),
  observedAt: z.date().nullable(),
  selectedVariant: z.string().nullable(),
  /**
   * Field-scoped sources only: true while the field still holds the value
   * this source was recorded against; false once it was overwritten. Null
   * for a source about the whole record.
   */
  supportsCurrentValue: z.boolean().nullable(),
  recorder: z.object({
    channel: auditChannelSchema,
    oauthClientId: z.string().nullable(),
    runId: runShortcode.nullable(),
    deviceId: deviceShortcode.nullable(),
  }),
  createdAt: z.date(),
});
export type EntitySourceRead = z.infer<typeof entitySourceRead>;
