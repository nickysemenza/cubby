import { z } from "zod";
import { productShortcode } from "./identifiers";

/**
 * Thin Product reference carried by cookbook browse and detail responses.
 * The detail page fetches the full Product separately so browse and MCP do not
 * carry its price and inventory joins.
 */
export const cookbookProductSummary = z.object({
  id: productShortcode,
  name: z.string(),
  coverUrl: z.string().nullable(),
});
