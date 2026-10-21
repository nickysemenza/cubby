import { productImagePurpose } from "../image-summary";
import { imageAnalysisSummarySchema } from "../image-identification";
import imageDefinition from "./18-image.entity";

export const imageOut = imageDefinition.readSchemas.output;

export {
  imageAnalysisSummarySchema,
  type ImageAnalysisSummary,
} from "../image-identification";
/** ProductImage's nullable join role. This stays in the declaration-safe
 * layer so Product read schemas carry attachment evidence without importing
 * the canonical Image module into entity declarations. */
export const productAttachmentImageOut = imageOut.extend({
  purpose: productImagePurpose.nullable(),
  // Populated only on a Product detail/get read (see `dbProductToAPI`); a
  // list read leaves this absent to keep list cost flat.
  analysisSummary: imageAnalysisSummarySchema.nullable().optional(),
});
