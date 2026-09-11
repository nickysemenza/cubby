import { fdcId } from "@cubby/usda-schemas";
import { z } from "zod";
import { amount, positiveAmount } from "./codec";
import { productShortcode } from "./identifier-fields";

const sourceMetadata = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("product"),
    productId: productShortcode,
  }),
  z.object({
    type: z.literal("food"),
    fdcId,
  }),
  z.object({
    type: z.literal("manual"),
  }),
]);

// A known zero is a valid one-way conversion from a positive source amount.
const mappingTargetAmount = amount.refine((a) => a.value >= 0, {
  error: "Mapping target must be zero or greater",
  path: ["value"],
});

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
  a: positiveAmount.describe(
    'left side of the pair, e.g. { value: 8, unit: "oz" }',
  ),
  b: mappingTargetAmount.describe(
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
    a: positiveAmount.describe(
      'left side of the pair, e.g. { value: 8, unit: "oz" }',
    ),
    b: mappingTargetAmount.describe(
      'right side of the pair, e.g. { value: 10, unit: "dollar" }',
    ),
    source: z.string().optional(),
  })
  .describe(
    'One conversion/price edge in the unit graph, e.g. 8 oz = $10 → { a: { value: 8, unit: "oz" }, b: { value: 10, unit: "dollar" } }. Money unit is "dollar"; nutrient edges use the b unit (e.g. "kcal", "g protein").',
  );
export type McpUnitMappingInput = z.infer<typeof mcpUnitMappingInput>;

export type UnitMappingInput = z.infer<typeof unitMappingInput>;

export const unitMappingWithMetadata = z.object({
  a: amount.describe('left side of the pair, e.g. { value: 8, unit: "oz" }'),
  b: amount.describe(
    'right side of the pair, e.g. { value: 10, unit: "dollar" }',
  ),
  source: z
    .string()
    .nullable()
    .describe('provenance note (null if unknown), e.g. "manual"'),
  sourceMetadata,
});

export const unitMappingOut = z.object({
  id: z.uuid(),
  a: amount.describe('left side of the pair, e.g. { value: 8, unit: "oz" }'),
  b: amount.describe(
    'right side of the pair, e.g. { value: 10, unit: "dollar" }',
  ),
  source: z
    .string()
    .nullable()
    .describe('provenance note (null if unknown), e.g. "manual"'),
  sourceMetadata,
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type UnitMapping = z.infer<typeof unitMappingWithMetadata>;

export const mcpUnitMappingOut = z.object({
  a: amount,
  b: amount,
  source: z.string().nullable(),
});

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
