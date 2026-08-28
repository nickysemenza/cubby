import { z } from "zod";

import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

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

export type EntityInspectorHealth = z.infer<typeof entityInspectorHealthSchema>;

export const entityInspectorHealth = defineOperationDomain("entity", {
  inspectorHealth: query({
    input: z.null(),
    output: entityInspectorHealthSchema,
    tags: [["entity", "inspectorHealth"]],
    freshness: { staleTime: 60_000 },
  }),
});
