import { z } from "zod";
import { amount } from "~/codec/codec";
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

// Base unit mapping without sourceMetadata (for input)
const unitMappingBase = z.object({
  a: amount.describe("first of pair"),
  b: amount.describe("second of pair"),
  source: z.string().nullable(),
});

// Unit mapping with sourceMetadata (for output/computed)
export const unitMappingWithMetadata = unitMappingBase.extend({
  sourceMetadata: sourceMetadata,
});

export const unitMappingInput = unitMappingBase.extend({
  id: z.uuid().optional(),
});

export const unitMappingOut = z
  .object({
    id: z.uuid(),
  })
  .extend(unitMappingWithMetadata.shape)
  .extend(dbTimestampsOut.shape);

export type UnitMapping = z.infer<typeof unitMappingWithMetadata>;
export type UnitMappingInput = z.infer<typeof unitMappingInput>;
