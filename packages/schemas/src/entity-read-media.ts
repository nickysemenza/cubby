import { z } from "zod";

import { displayImagesField } from "./display-images";
import { imageOut } from "./entity-definitions/field-primitives";

export const entityAttachmentRole = z.enum(["attachment", "cover", "logo"]);

export const entityAttachmentRead = imageOut.extend({
  role: entityAttachmentRole,
  position: z.number().int().nonnegative(),
});
export type EntityAttachmentRead = z.infer<typeof entityAttachmentRead>;

const listMediaFields = z.object({ displayImages: displayImagesField });
const detailMediaFields = z.object({
  displayImages: displayImagesField,
  attachments: z.array(entityAttachmentRead),
  /** The code a read asked for when it was a merged-away code (ADR 0006). */
  redirectedFrom: z.string().nullable(),
  /** Codes of entities merged into this one; each still redirects here. */
  previousShortcodes: z.array(z.string()),
});

const entityReadObject = (schema: z.ZodType) => {
  if (!(schema instanceof z.ZodObject))
    throw new Error("Entity read schemas must be Zod objects");
  return schema;
};

/** Public read decorators; repository schemas remain domain-shaped internally. */
export function withEntityListMedia<Fields extends z.ZodRawShape>(
  schema: z.ZodObject<Fields>,
): z.ZodObject<Fields & typeof listMediaFields.shape>;
export function withEntityListMedia<S extends z.ZodType>(
  schema: S,
): z.ZodType<z.output<S> & z.output<typeof listMediaFields>>;
export function withEntityListMedia(schema: z.ZodType): z.ZodType {
  return entityReadObject(schema).extend(listMediaFields.shape);
}

export function withEntityDetailMedia<Fields extends z.ZodRawShape>(
  schema: z.ZodObject<Fields>,
): z.ZodObject<Fields & typeof detailMediaFields.shape>;
export function withEntityDetailMedia<S extends z.ZodType>(
  schema: S,
): z.ZodType<z.output<S> & z.output<typeof detailMediaFields>>;
export function withEntityDetailMedia(schema: z.ZodType): z.ZodType {
  return entityReadObject(schema).extend(detailMediaFields.shape);
}
