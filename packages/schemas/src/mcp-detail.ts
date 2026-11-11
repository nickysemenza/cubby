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
  .optional()
  .describe(
    "Only these fields, overriding resultDetail; dot paths select nested values (e.g. 'financialReconciliation.status'), `id` is always kept, and an unknown field is refused with the closest keys.",
  );

/** A get/list read additionally offers the compact preset and field selection. */
export const mcpReadSelectionFields = {
  resultDetail: z
    .enum(["summary", "compact", "full"])
    .default("summary")
    .describe(
      "'summary': identity and relevant status; 'compact': the entity's required list fields, nested objects as their scalars (dataQuality as status and score), no child collections, field resolutions, display labels or long notes; 'full': the complete MCP projection.",
    ),
  fields: selectedFields,
};

/** Row selection for every other paged MCP read. */
export const mcpRowSelectionFields = {
  resultDetail: z
    .enum(["compact", "full"])
    .default("compact")
    .describe(
      "'compact': scalars and nested scalars, no child collections or images; 'full': complete rows.",
    ),
  fields: selectedFields,
};
