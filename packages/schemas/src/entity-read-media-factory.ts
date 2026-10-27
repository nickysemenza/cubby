import { z } from "zod";

import { displayImagesField } from "./display-images";
import { entityAttachmentRoleValues } from "./entity-attachment";
import { detailBreadcrumbSchema } from "./entity-detail-summary";

export const entityAttachmentRole = z.enum(entityAttachmentRoleValues);

/** The compiler supplies raw Image projections; public reads supply canonical bounded Images. */
export function createEntityReadMedia<ImageFields extends z.ZodRawShape>(
  imageSchema: z.ZodObject<ImageFields>,
) {
  const entityAttachmentRead = imageSchema.extend({
    role: entityAttachmentRole,
    position: z.number().int().nonnegative(),
  });
  const entityAttachmentList = z.array(entityAttachmentRead);

  const listMediaFields = z.object({ displayImages: displayImagesField });
  const detailMediaFields = z.object({
    displayImages: displayImagesField,
    attachments: entityAttachmentList,
    /** Records above this one, from a declared `hero.breadcrumb` field. */
    breadcrumb: detailBreadcrumbSchema.optional(),
    /** Where facts about this record were seen, newest first. */
  });

  const entityReadObject = (schema: z.ZodType) => {
    if (!(schema instanceof z.ZodObject))
      throw new Error("Entity read schemas must be Zod objects");
    return schema;
  };

  /** Public read decorators; repository schemas remain domain-shaped internally. */
  function withEntityListMedia<Fields extends z.ZodRawShape>(
    schema: z.ZodObject<Fields>,
  ): z.ZodObject<
    Omit<Fields, keyof typeof listMediaFields.shape> &
      typeof listMediaFields.shape
  >;
  function withEntityListMedia<S extends z.ZodType>(
    schema: S,
  ): z.ZodType<z.output<S> & z.output<typeof listMediaFields>>;
  function withEntityListMedia(schema: z.ZodType): z.ZodType {
    return entityReadObject(schema).extend(listMediaFields.shape);
  }

  function withEntityDetailMedia<Fields extends z.ZodRawShape>(
    schema: z.ZodObject<Fields>,
  ): z.ZodObject<
    Omit<Fields, keyof typeof detailMediaFields.shape> &
      typeof detailMediaFields.shape
  >;
  function withEntityDetailMedia<S extends z.ZodType>(
    schema: S,
  ): z.ZodType<z.output<S> & z.output<typeof detailMediaFields>>;
  function withEntityDetailMedia(schema: z.ZodType): z.ZodType {
    return entityReadObject(schema).extend(detailMediaFields.shape);
  }

  return {
    entityAttachmentRead,
    entityAttachmentList,
    withEntityListMedia,
    withEntityDetailMedia,
  };
}
