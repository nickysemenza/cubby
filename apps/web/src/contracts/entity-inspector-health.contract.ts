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

export const entityInspectorHealthContract = defineContract("entity", {
  inspectorHealth: query({
    input: z.null(),
    output: entityInspectorHealthSchema,
  }),
});
