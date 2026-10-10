import { z } from "zod";

import { auditChannelSchema } from "./context";
import { deviceShortcode, runShortcode } from "./identifiers";

/** A quote is the relevant excerpt, not a page dump. */
export const ENTITY_SOURCE_QUOTE_MAX = 2000;

const sourceFields = {
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
const hasUrlOrQuote = (source: { url?: string; quote?: string }) =>
  source.url !== undefined || source.quote !== undefined;
const urlOrQuote = { message: "A source needs a url or quote" };

/**
 * One Source a caller supplies with a write (GLOSSARY "Source"): where a fact
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
  .refine(hasUrlOrQuote, urlOrQuote);
export type EntitySourceInput = z.infer<typeof entitySourceInput>;

export const entitySourceInputs = z
  .array(entitySourceInput)
  .max(50)
  .describe(
    "Where the written facts were seen. Stored with the write in the same transaction.",
  );

/** A source about the whole record (image attach): no field scope. */
export const entityRecordSourceInputs = z
  .array(z.strictObject(sourceFields).refine(hasUrlOrQuote, urlOrQuote))
  .max(50)
  .describe("Where this file was found; recorded on the target record.");

export const entitySourceRead = z.object({
  fieldPath: z.string().nullable(),
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
