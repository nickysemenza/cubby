import { fdcId } from "@cubby/usda-schemas";
import { z } from "zod";
import { productId } from "./identifiers";
import { amount } from "./codec";

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

// Unit mapping with sourceMetadata (for output/computed)
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
