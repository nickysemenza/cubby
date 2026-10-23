import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

export const entityInspectorHealthSchema = z.object({
  counts: z.record(z.string(), z.number().int().nonnegative()),
  search: z.record(
    z.string(),
    z.object({
      documents: z.number().int().nonnegative(),
      embeddings: z.number().int().nonnegative(),
    }),
  ),
});

export const entityInspectorHealthContract = defineContract(
  "entity",
  {
    // Interactive inventory work and integrity/repair diagnostics.
    inspectorHealth: query({
      description:
        "Read entity inspector and search-index health counts. Use the result to diagnose stale or missing derived records; this does not repair them.",
      readPolicy: "strong",
      input: z.null(),
      output: entityInspectorHealthSchema,
    }),
  },
  { exposure: "capability", mcpToolGroup: "maintenance" },
);
