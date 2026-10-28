import { z } from "zod";

/** Static relation semantics resolved once against the complete entity graph. */
export const relationSectionPlanSchema = z.object({
  target: z.string(),
  descriptorId: z.string(),
  filterKey: z.string(),
  urlKey: z.string(),
  subtree: z.string().nullable(),
  seed: z
    .object({
      intent: z.string(),
      field: z.string(),
      fields: z.array(z.string()),
    })
    .nullable(),
  seedMultiple: z.boolean(),
  columns: z.array(z.string()).nullable(),
  sort: z.object({ field: z.string(), direction: z.enum(["asc", "desc"]) }),
  limit: z.number().int().positive().nullable(),
  pageSize: z.number().int().positive(),
  groupBy: z.string().nullable(),
  backReferenceColumn: z.string().nullable(),
  derived: z.boolean(),
});
export type CompiledRelationSectionPlan = z.infer<
  typeof relationSectionPlanSchema
>;
