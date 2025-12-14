import { z } from "zod";
import { dbTimestampsOut } from "./common";
import { amount, type Amount } from "~/codec/codec";
import { productId } from "./identifiers";
import { wasmServer } from "~/lib/wasm";

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
export const unitMappingBase = z.object({
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
export async function parseUnitMappingString(
  input: string,
): Promise<ParsedUnitMappingResult> {
  const result = (await wasmServer.parse_unit_mapping(
    input,
  )) as WasmUnitMappingResult;
  // Normalize undefined to null for source field
  return {
    a: result.a,
    b: result.b,
    source: result.source ?? null,
  };
}

/**
 * Validate a unit mapping string (async).
 * Returns true if valid, false if invalid.
 */
export async function isValidUnitMappingString(
  input: string,
): Promise<boolean> {
  try {
    await parseUnitMappingString(input);
    return true;
  } catch {
    return false;
  }
}

// Shorthand string format like "4 lb = $5 @ whole foods" - basic string validation
// Note: Full format validation happens async via parseUnitMappingString
export const unitMappingFlexible = z.string().min(1);

// Transform function to convert strings to objects (async)
export async function transformUnitMapping(
  val: string,
): Promise<z.infer<typeof unitMappingBase>> {
  const parsed = await parseUnitMappingString(val);
  return {
    a: parsed.a,
    b: parsed.b,
    source: parsed.source,
  };
}

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
