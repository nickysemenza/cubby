import { describe, expect, it } from "vitest";
import { z } from "zod";
import { productMcpOut, productTopLevelOut } from "./product";

/**
 * Product is the ONLY `xOut`/`xMcpOut` pair left that can drift.
 *
 * Every other slim MCP shape (recipe, meal, ingredient, location, inventory) is
 * now DERIVED from its plain counterpart with `.pick()`/`.omit()`, so the type
 * system enforces what this test used to assert by hand — a key that stops
 * existing on the plain shape is a compile error, not a test failure.
 *
 * `productMcpOut` stays hand-written because it adds `effectivePrice` (the
 * resolved costing price) next to `price` (the raw manual override), a pairing
 * `productTopLevelOut` does not carry: `price` there is the override and the
 * resolved value lives at `pricing.effectivePrice`. A `.pick()` cannot express
 * that, so the guard below keeps the hand-written half honest instead.
 */

/**
 * Does `schema` accept `null` at this position? Unwraps `.optional()` /
 * `.default(...)` to see through `.nullish()` (`nullable().optional()`) down
 * to the `.nullable()` underneath — the same `.unwrap()` traversal
 * `deriveUpdateFields` (base-entity.ts) already relies on for `.default(...)`.
 *
 * `.unwrap()` is typed as Zod's core `$ZodType`; the public `z.ZodType` (the
 * one `instanceof` checks work against) is its subtype, hence the localized
 * cast — same pattern `deriveUpdateFields` already uses for the same reason.
 */
function acceptsNull(schema: z.core.$ZodType): boolean {
  if (schema instanceof z.ZodNullable) return true;
  if (schema instanceof z.ZodOptional) return acceptsNull(schema.unwrap());
  if (schema instanceof z.ZodDefault) return acceptsNull(schema.unwrap());
  return false;
}

/**
 * Look up `key` in a schema field map. The caller always got `key` from
 * `Object.keys(fields)`, so the lookup is never actually undefined — this just
 * says so past `noUncheckedIndexedAccess`.
 */
type ProductFieldMap =
  | typeof productTopLevelOut.shape
  | typeof productMcpOut.shape;

function field(fields: ProductFieldMap, key: string): z.ZodType {
  const value = Object.entries(fields).find(([name]) => name === key)?.[1];
  if (!value) throw new Error(`expected a schema at key "${key}"`);
  return value;
}

const plainFields = productTopLevelOut.shape;
const mcpFields = productMcpOut.shape;

/**
 * The keys `productMcpOut` is allowed to hold that `productTopLevelOut` has no
 * counterpart for. Each is a projection or a join the plain product row does
 * not carry under that name — not a field that drifted.
 */
const DERIVED_KEYS = new Set([
  // The resolved costing price; `productPricingOut.effectivePrice` is its
  // counterpart, and it is deliberately hoisted next to the raw `price`.
  "effectivePrice",
  "imageCount",
  "coverImageUrl",
  // Resolved off the joined USDA food row, not stored on the product.
  "usdaFdcId",
  "ingredientId",
  "unitMappings",
  "primaryGtin",
]);

describe("productMcpOut stays within productTopLevelOut", () => {
  it("adds no key beyond the documented derived ones", () => {
    const unexpected = Object.keys(mcpFields).filter(
      (key) => !(key in plainFields) && !DERIVED_KEYS.has(key),
    );
    expect(
      unexpected,
      "keys present on productMcpOut but absent from productTopLevelOut",
    ).toEqual([]);
  });

  it("matches nullability on every shared key", () => {
    const mismatches = Object.keys(mcpFields)
      .filter((key) => key in plainFields)
      .filter(
        (key) =>
          acceptsNull(field(mcpFields, key)) !==
          acceptsNull(field(plainFields, key)),
      )
      .map(
        (key) =>
          `${key}: mcp accepts null = ${acceptsNull(field(mcpFields, key))}, plain accepts null = ${acceptsNull(field(plainFields, key))}`,
      );
    expect(mismatches).toEqual([]);
  });

  /**
   * The regression this file exists for: `price` used to mean the RESOLVED
   * costing price on the MCP shape and the RAW manual override on the plain
   * one — the same key, swapped meaning. Both now mean the override, and the
   * resolved value has its own name on both sides.
   */
  it("keeps `price` the raw override on both sides, with the resolved value named separately", () => {
    expect(Object.keys(mcpFields)).toContain("effectivePrice");
    expect(Object.keys(mcpFields)).not.toContain("priceOverride");
    expect(field(mcpFields, "price").description).toContain("override");
    expect(field(plainFields, "price").description).toContain("override");
  });
});
