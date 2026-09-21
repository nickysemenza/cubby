import { z } from "zod";
import imageDefinition from "./18-image.entity";
import { readFieldSchemas } from "./definition";

export const imageOut = z.object(readFieldSchemas(imageDefinition));

/** ProductImage's nullable join role. This stays in the declaration-safe
 * layer so Product read schemas carry attachment evidence without importing
 * the canonical Image module into entity declarations. */
export const productAttachmentImageOut = imageOut.extend({
  purpose: z.enum(["item", "label"]).nullable(),
});
