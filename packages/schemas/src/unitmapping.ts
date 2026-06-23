import { fdcId } from "@cubby/usda-schemas";
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
    fdcId,
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
  .extend({ source: z.string().optional() })
  .describe(
    'One conversion/price edge in the unit graph, e.g. 8 oz = $10 → { a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } }. Money unit is "dollar"; nutrient edges use the b unit (e.g. "kcal", "g protein").',
  );
export type McpUnitMappingInput = z.infer<typeof mcpUnitMappingInput>;

export const unitMappingOut = z
  .object({
    id: z.uuid(),
  })
  .extend(unitMappingWithMetadata.shape)
  .extend(dbTimestampsOut.shape);

export type UnitMapping = z.infer<typeof unitMappingWithMetadata>;
export type UnitMappingInput = z.infer<typeof unitMappingInput>;

/**
 * Build a `UnitMapping` edge with the "manual" provenance stamp — the shape that
 * the enrichment workbench's live preview, design fixtures, and unit tests all
 * hand-rolled identically (`{ a, b, source, sourceMetadata: { type: "manual" } }`).
 * For DB-backed rows that also carry `id`/timestamps, build `unitMappingOut`
 * directly; this is only for the in-memory edge type.
 */
export const manualUnitMapping = (
  a: UnitMapping["a"],
  b: UnitMapping["b"],
  source: string | null = "manual",
): UnitMapping => ({ a, b, source, sourceMetadata: { type: "manual" } });
