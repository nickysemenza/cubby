import { z } from "zod";
import { projectShortcode } from "./identifier-fields";

export const fieldResolutionSourceSchema = z.object({
  entityType: z.enum(["project", "task", "purchase", "productCategory"]),
  entityId: z.string(),
  name: z.string().nullable(),
});

/** Assignment intent is independent of the value currently selected by a rule. */
export const fieldResolutionSchema = z.object({
  mode: z.enum(["inherit", "explicit", "none", "allocated"]),
  storedValue: z.json(),
  value: z.json(),
  fallbackValue: z.json(),
  source: z.string(),
  sourceEntity: fieldResolutionSourceSchema.nullable(),
  matchesFallback: z.boolean(),
  canReset: z.boolean(),
});

export const fieldResolutionsSchema = z.record(
  z.string(),
  fieldResolutionSchema,
);
export const optionalFieldResolutionsSchema = fieldResolutionsSchema.optional();
export type FieldResolution = z.infer<typeof fieldResolutionSchema>;
export type FieldResolutions = z.infer<typeof fieldResolutionsSchema>;

export const projectAllocationSchema = z.object({
  projectId: projectShortcode.nullable(),
  projectName: z.string().nullable(),
  amount: z.number().nullable(),
  basis: z.enum(["positive", "refund", "default"]),
  incomplete: z.boolean(),
});

export const projectAllocationsSchema = z.array(projectAllocationSchema);
export const optionalProjectAllocationsSchema =
  projectAllocationsSchema.optional();
