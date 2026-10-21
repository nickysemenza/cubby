import { productSummaryWithCover } from "./product-fields";

/**
 * Thin Product reference carried by cookbook browse and detail responses.
 * The detail page fetches the full Product separately so browse and MCP do not
 * carry its price and inventory joins.
 */
export const cookbookProductSummary = productSummaryWithCover;

import { z } from "zod";
import { displayImagesField } from "./display-images";
export function cookbookReadSchemas<S extends z.ZodRawShape>(
  base: z.ZodObject<S>,
) {
  const output = base.extend({ displayImages: displayImagesField });
  return { output, list: output, detail: output };
}
