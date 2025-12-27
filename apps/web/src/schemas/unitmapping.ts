import { z } from "zod";
import { type Amount, amount } from "~/codec/codec";
import { wasm } from "~/lib/wasm";
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

// Raw result from WASM (source can be undefined)
interface WasmUnitMappingResult {
  a: Amount;
  b: Amount;
  source?: string;
}

// Parsed unit mapping result (source normalized to null)
interface ParsedUnitMappingResult {
  a: Amount;
  b: Amount;
  source: string | null;
}

/**
 * Parse a unit mapping string using WASM.
 * Supports formats: "4 lb = $5", "$5/4lb", "4 lb = $5 @ store"
 */
export const parseUnitMappingString = (
  input: string,
): ParsedUnitMappingResult => {
  const result = wasm.parse_unit_mapping(input) as WasmUnitMappingResult;
  // Normalize undefined to null for source field
  return {
    a: result.a,
    b: result.b,
    source: result.source ?? null,
  };
};

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
