import { z } from "zod";
import { projectShortcode } from "./identifier-fields";

export const fieldResolutionSourceSchema = z.object({
  entityKind: z.enum([
    "project",
    "task",
    "purchase",
    "productCategory",
    "spendingCategory",
    "vendor",
    "expense",
    "vendorAccount",
    "financialAccount",
  ]),
  entityId: z.string(),
  name: z.string().nullable(),
});

export const fieldResolutionEvaluationSchema =
  fieldResolutionSourceSchema.extend({
    value: z.json(),
    assigned: z.boolean(),
  });

/** Assignment intent is independent of the value currently selected by a rule. */
export const fieldResolutionSchema = z.object({
  mode: z.enum(["inherit", "explicit", "none", "allocated"]),
  storedValue: z.json(),
  value: z.json(),
  fallbackValue: z.json(),
  source: z.string(),
  sourceEntity: fieldResolutionSourceSchema.nullable(),
  fallbackSource: fieldResolutionSourceSchema.nullable().optional(),
  evaluation: z.array(fieldResolutionEvaluationSchema).optional(),
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

/**
 * One value of a rollup over several resolutions (a Product's owners across
 * its Inventory): what to show, the record it names, and whether it is only
 * inherited somewhere. The `resolvedList` display format renders it.
 */
export const resolvedListItemSchema = z.object({
  label: z.string(),
  /** The record the item names (entity key + shortcode), when it is one. */
  ref: z.object({ entityKind: z.string(), entityId: z.string() }).nullable(),
  inherited: z.boolean(),
});
export const resolvedListSchema = z.array(resolvedListItemSchema);
export type ResolvedListItem = z.infer<typeof resolvedListItemSchema>;

export const projectAllocationSchema = z.object({
  projectId: projectShortcode.nullable(),
  projectName: z.string().nullable(),
  amount: z.number().nullable(),
  basis: z.enum(["positive", "refund", "default", "unclassified"]),
  incomplete: z.boolean(),
});

export const projectAllocationsSchema = z.array(projectAllocationSchema);
export const optionalProjectAllocationsSchema =
  projectAllocationsSchema.optional();
