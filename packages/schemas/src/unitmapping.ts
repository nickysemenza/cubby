import { z } from "zod";
import { amount } from "./codec";

// Base unit mapping without sourceMetadata (for input).
// A mapping is one conversion or price/nutrient edge in the unit graph, e.g.
// "8 oz = $10". The costing engine treats a weight->money edge as the cost basis
// for an ingredient measured by weight; money is the "dollar" unit and nutrient
// edges use the b unit (e.g. "kcal" or "g protein").
export const unitMappingBase = z.object({
  a: amount.describe('left side of the pair, e.g. { value: 8, unit: "oz" }'),
  b: amount.describe(
    'right side of the pair, e.g. { value: 10, unit: "dollar" }',
  ),
  source: z
    .string()
    .nullable()
    .describe('provenance note (null if unknown), e.g. "manual"'),
});

export const unitMappingInput = z.object({
  a: amount.describe('left side of the pair, e.g. { value: 8, unit: "oz" }'),
  b: amount.describe(
    'right side of the pair, e.g. { value: 10, unit: "dollar" }',
  ),
  source: z
    .string()
    .nullable()
    .describe('provenance note (null if unknown), e.g. "manual"'),
  id: z.uuid().optional(),
});

/**
 * A unit mapping shaped for MCP tools: the canonical edge minus `id` (create-only)
 * with `source` made omittable so LLM callers needn't pass `null` explicitly. Field
 * docs for `a`/`b`/`source` come from `unitMappingBase`. Normalize back to
 * `unitMappingInput` (source: string|null) at the tool boundary.
 */
export const mcpUnitMappingInput = z
  .object({
    a: amount.describe('left side of the pair, e.g. { value: 8, unit: "oz" }'),
    b: amount.describe(
      'right side of the pair, e.g. { value: 10, unit: "dollar" }',
    ),
    source: z.string().optional(),
  })
  .describe(
    'One conversion/price edge in the unit graph, e.g. 8 oz = $10 → { a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } }. Money unit is "dollar"; nutrient edges use the b unit (e.g. "kcal", "g protein").',
  );
export type McpUnitMappingInput = z.infer<typeof mcpUnitMappingInput>;

export type UnitMappingInput = z.infer<typeof unitMappingInput>;
