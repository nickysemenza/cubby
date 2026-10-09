import { z } from "zod";
import imageDefinition from "./18-image.entity";
import { readFieldSchemas } from "./definition";
import { productShortcode } from "../identifier-fields";
import { moneyNullable } from "../money";
import { productCategorySummary } from "../product-category-fields";

export const imageOut = z.object(readFieldSchemas(imageDefinition));

/**
 * Condensed on-device/cloud analysis for one Image: top classifications, OCR
 * text, and the cloud description, so an agent can decide whether to view the
 * full image. Declared here (not `image.ts`) because `image.ts` already
 * imports `imageOut` from this module — a reverse import would cycle.
 * `null` means no analysis exists yet for the image; a present object's own
 * fields are independently nullable/empty depending on which analyses ran.
 */
export const imageAnalysisSummarySchema = z.object({
  description: z.string().nullable(),
  classifications: z.array(z.string()),
  recognizedText: z.string().nullable(),
});
export type ImageAnalysisSummary = z.infer<typeof imageAnalysisSummarySchema>;

/** ProductImage's nullable join role. This stays in the declaration-safe
 * layer so Product read schemas carry attachment evidence without importing
 * the canonical Image module into entity declarations. */
export const productAttachmentImageOut = imageOut.extend({
  purpose: z.enum(["item", "label"]).nullable(),
  // Populated only on a Product detail/get read (see `dbProductToAPI`); a
  // list read leaves this absent to keep list cost flat.
  analysisSummary: imageAnalysisSummarySchema.nullable().optional(),
});

/** A Location's identity Product. Here rather than `location-fields.ts`, which
 * a list route's search validation loads, because the cover image reads the
 * Image declaration. */
export const locationIdentityProductOut = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  category: productCategorySummary.nullable(),
  coverImage: imageOut.nullable(),
  price: moneyNullable,
});
export type LocationIdentityProductOut = z.infer<
  typeof locationIdentityProductOut
>;
