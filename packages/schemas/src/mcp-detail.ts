import { z } from "zod";

export const mcpResultDetail = z
  .enum(["summary", "full"])
  .default("summary")
  .describe(
    "How much record detail to return. 'summary' returns identity and relevant status; 'full' returns the complete MCP projection.",
  );

export const mcpResultDetailFields = { resultDetail: mcpResultDetail };

const selectedFields = z
  .array(z.string().trim().min(1).max(200))
  .min(1)
  .max(100)
  .optional();

/** A get/list read additionally offers the compact preset and field selection. */
export const mcpReadSelectionFields = {
  resultDetail: z
    .enum(["summary", "compact", "full"])
    .default("summary")
    .describe(
      "How much record detail to return. 'summary' returns identity and relevant status; 'compact' returns the same identity-and-status row from list and get: the entity's required list fields, nested objects reduced to their scalars (dataQuality to status and score), without child collections, field resolutions, display labels or long notes text; 'full' returns the complete MCP projection.",
    ),
  fields: selectedFields.describe(
    "Return only these fields of the full projection (overrides resultDetail). Dot paths select nested values, e.g. 'financialReconciliation.status'; `id` is always included. An unknown top-level field is refused with the allowed keys.",
  ),
};

/** Row selection for every other paged MCP read. */
export const mcpRowSelectionFields = {
  resultDetail: z
    .enum(["compact", "full"])
    .default("compact")
    .describe(
      "How much of each row to return. 'compact' keeps scalar fields and nested objects reduced to their scalars, without child collections or image payloads; 'full' returns complete rows.",
    ),
  fields: selectedFields.describe(
    "Return only these row fields (overrides resultDetail). Dot paths select nested values; a row's `id` is always included. An unknown field is refused with the closest allowed keys.",
  ),
};
