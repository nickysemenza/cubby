import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { amount } from "~/codec/codec";
import { parseConversionString } from "./config-parsers";

export const sourceMetadata = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("product"),
    productId: z.string().uuid(),
  }),
  z.object({
    type: z.literal("food"),
    fdcId: z.number(),
  }),
  z.object({
    type: z.literal("manual"),
  }),
]);

// Base unit mapping without sourceMetadata (for input)
export const unitMappingBase = z.object({
  a: amount.describe("first of pair"),
  b: amount.describe("second of pair"),
  source: z.string().nullable(),
});

// Unit mapping with sourceMetadata (for output/computed)
export const unitMappingWithMetadata = unitMappingBase.extend({
  sourceMetadata: sourceMetadata,
});

// Shorthand string format like "4 lb = $5 @ whole foods" - validation only
export const unitMappingFlexible = z.string().refine(
  (val) => {
    try {
      parseConversionString(val);
      return true;
    } catch {
      return false;
    }
  },
  {
    message: "Invalid unit mapping format. Expected: '4 lb = $5 @ store'",
  },
);

// Transform function to convert strings to objects
export function transformUnitMapping(
  val: string,
): z.infer<typeof unitMappingBase> {
  const parsed = parseConversionString(val);
  return {
    a: parsed.from,
    b: parsed.to,
    source: parsed.source || null,
  };
}

export const unitMappingInput = unitMappingBase.extend({
  id: z.string().uuid().optional(),
});

export const unitMappingOut = z
  .object({
    id: z.string().uuid(),
  })
  .merge(unitMappingWithMetadata)
  .merge(dbTimestampsOut);

export type UnitMapping = z.infer<typeof unitMappingWithMetadata>;
export type UnitMappingInput = z.infer<typeof unitMappingInput>;
