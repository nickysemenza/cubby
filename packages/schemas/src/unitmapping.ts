import { z } from "zod";
import { amount } from "./codec";
import { dbTimestampsOut } from "./common";
import { productId } from "./identifiers";

const sourceMetadata = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("product"),
    productId: productId,
  }),
  z.object({
    type: z.literal("food"),
    fdcId: z.number(),
  }),
  z.object({
    type: z.literal("manual"),
  }),
]);

// Base unit mapping without sourceMetadata (for input).
// A mapping is one conversion or price/nutrient edge in the unit graph, e.g.
// "8 oz = $10". The costing engine treats a weight->money edge as the cost basis
// for an ingredient measured by weight; money is the "dollar" unit and nutrient
// edges use the b unit (e.g. "kcal" or "g protein").
const unitMappingBase = z.object({
  a: amount.describe('left side of the pair, e.g. { value: 8, unit: "oz" }'),
  b: amount.describe(
    'right side of the pair, e.g. { value: 10, unit: "dollar" }',
  ),
  source: z
    .string()
    .nullable()
    .describe('provenance note (null if unknown), e.g. "manual"'),
});

// Unit mapping with sourceMetadata (for output/computed)
export const unitMappingWithMetadata = unitMappingBase.extend({
  sourceMetadata: sourceMetadata,
});

export const unitMappingInput = unitMappingBase.extend({
  id: z.uuid().optional(),
});

/**
 * A unit mapping shaped for MCP tools: the canonical edge minus `id` (create-only)
 * with `source` made omittable so LLM callers needn't pass `null` explicitly. Field
 * docs for `a`/`b`/`source` come from `unitMappingBase`. Normalize back to
 * `unitMappingInput` (source: string|null) at the tool boundary.
 */
export const mcpUnitMappingInput = unitMappingInput
  .omit({ id: true })
  .extend({ source: z.string().optional() });
export type McpUnitMappingInput = z.infer<typeof mcpUnitMappingInput>;

export const unitMappingOut = z
  .object({
    id: z.uuid(),
  })
  .extend(unitMappingWithMetadata.shape)
  .extend(dbTimestampsOut.shape);

export type UnitMapping = z.infer<typeof unitMappingWithMetadata>;
export type UnitMappingInput = z.infer<typeof unitMappingInput>;
