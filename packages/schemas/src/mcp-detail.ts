import { z } from "zod";

export const mcpResultDetail = z
  .enum(["summary", "full"])
  .default("summary")
  .describe(
    "How much record detail to return. 'summary' returns identity and relevant status; 'full' returns the complete MCP projection.",
  );

export const mcpResultDetailFields = { resultDetail: mcpResultDetail };
export type McpResultDetail = z.output<typeof mcpResultDetail>;

/** A get/list read additionally offers the compact preset and field selection. */
export const mcpReadSelectionFields = {
  resultDetail: z
    .enum(["summary", "compact", "full"])
    .default("summary")
    .describe(
      "How much record detail to return. 'summary' returns identity and relevant status; 'compact' returns the entity's declared list fields without nested child collections; 'full' returns the complete MCP projection.",
    ),
  fields: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(100)
    .optional()
    .describe(
      "Return only these fields of the full projection (overrides resultDetail). Dot paths select nested values, e.g. 'financialReconciliation.status'; `id` is always included. An unknown top-level field is refused with the allowed keys.",
    ),
};
