import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ingredientMcpOut, ingredientOut } from "./ingredient";
import {
  inventoryMcpOut,
  inventoryWithLocationAndProductOut,
} from "./inventory";
import { locationMcpOut, locationOut } from "./location";
import { mealMcpOut, mealOut } from "./meal";
import { productMcpOut, productTopLevelOut } from "./product";
import { recipeMcpOut, recipeOut } from "./recipe";

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
/**
 * Look up `key` in `shape`. The caller always got `key` from
 * `Object.keys(shape)` (or checked `key in shape` first), so the lookup is
 * never actually undefined — this just says so past `noUncheckedIndexedAccess`.
 */
function field(shape: Record<string, z.ZodType>, key: string): z.ZodType {
  const value = shape[key];
  if (!value) throw new Error(`expected a schema at key "${key}"`);
  return value;
}

function acceptsNull(schema: z.ZodType): boolean {
  if (schema instanceof z.ZodNullable) return true;
  if (schema instanceof z.ZodOptional)
    return acceptsNull(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodDefault)
    return acceptsNull(schema.unwrap() as z.ZodType);
  return false;
}

interface McpOutPair {
  entity: string;
  plain: z.ZodObject<z.ZodRawShape>;
  mcp: z.ZodObject<z.ZodRawShape>;
  /**
   * Set only when this pair is a documented, investigated exception — see the
   * inline comment above the entry for what specifically diverges and why.
   * Leave unset for a pair that is expected to actually pass; a pair with
   * `except` set is asserted to be DOCUMENTED, not asserted to be a subset.
   */
  except?: string;
}

/**
 * Every currently-known `xOut`/`xMcpOut` pair that is a genuine "slim MCP
 * projection of the plain output" — i.e. the MCP shape is meant to be
 * assembled entirely from fields the plain shape already carries. Add a new
 * entity here in one line; the test below covers it automatically.
 *
 * Deliberately NOT every `*McpOut` in the package: several (e.g.
 * `purchaseProductsMcpOut`, `projectResourcesMcpOut`,
 * `cookbookSummariesMcpOut`, `recipeDetailMcpOut`) are
 * `createItemsResponseSchema(xOut)` / direct aliases of the plain schema
 * itself, not a separate hand-maintained projection — there is no drift
 * possible because there is no second declaration to drift from.
 */
const PAIRS: McpOutPair[] = [
  { entity: "recipe", plain: recipeOut, mcp: recipeMcpOut },
  { entity: "meal", plain: mealOut, mcp: mealMcpOut },
  {
    entity: "product",
    plain: productTopLevelOut,
    mcp: productMcpOut,
    // `productMcpOut.price` means "effective/costing price" (what
    // `productPricingOut` calls the resolved value); `productTopLevelOut.price`
    // means "the raw manual override" ("null resumes the Expense-derived
    // fallback"). Same key name, SWAPPED meaning — not just a nullability or
    // constraint mismatch. MCP additionally has `priceOverride`, which carries
    // what `productTopLevelOut.price` actually means, but productTopLevelOut
    // has no field under that name at all. Needs a human naming decision, not
    // a mechanical fix.
    except:
      "price/priceOverride: the `price` key means different things in each shape, and priceOverride has no counterpart key in productTopLevelOut",
  },
  {
    entity: "ingredient",
    plain: ingredientOut,
    mcp: ingredientMcpOut,
    // `ingredientMcpOut` (products/recipeCount/usdaFdcId) is a bespoke,
    // hand-assembled aggregate — no single plain ingredient output
    // (`ingredientOut`, `ingredientListItemOut`, `enrichmentRowOut`) carries
    // that exact field combination under those names (the closest,
    // `ingredientListItemOut`, has `product` — singular, full objects — and
    // `ownRecipeCount`, not `products`/`recipeCount`).
    except:
      "products/recipeCount/usdaFdcId have no matching keys in ingredientOut",
  },
  {
    entity: "location",
    plain: locationOut,
    mcp: locationMcpOut,
    // `locationMcpOut` combines `parentName` + `parentId` + `children` in one
    // object; no single plain location output carries all three under those
    // names (`locationWithParentNameOut` has `parentName` only with no
    // `children`; `locationListItemOut` has `parent`/`children` but not
    // `parentId`/`parentName`).
    except: "parentId/parentName/children have no matching keys in locationOut",
  },
  {
    entity: "inventory",
    plain: inventoryWithLocationAndProductOut,
    mcp: inventoryMcpOut,
    // `inventoryMcpOut.product` / `.location` are `.nullable()`; the plain
    // counterpart's (`inventoryWithLocationAndProductOut`, via
    // `inventoryWithLocationAndProductFields`) are REQUIRED objects — a real
    // inventory entry always resolves both through its FK join. Worth a
    // second look: this reads like the MCP side over-widened defensively
    // rather than a real possibility, but that call belongs to whoever owns
    // the MCP inventory tools, not this test.
    except:
      "product/location are .nullable() on the MCP side but required on inventoryWithLocationAndProductOut",
  },
];

describe("MCP output shapes stay within their plain counterpart", () => {
  it.each(PAIRS.filter((pair) => !pair.except))(
    "$entity: every key in the MCP shape exists in the plain shape, with matching nullability",
    ({ plain, mcp }) => {
      // Cast to Record<string, z.ZodType>: zod's raw shape type is keyed by its
      // internal `$ZodType`, and a computed-key lookup by a key we just pulled
      // from `Object.keys(...)` is always defined — the cast just says so.
      const plainShape = plain.shape as Record<string, z.ZodType>;
      const mcpShape = mcp.shape as Record<string, z.ZodType>;

      const missingKeys = Object.keys(mcpShape).filter(
        (key) => !(key in plainShape),
      );
      expect(
        missingKeys,
        "keys present on the MCP shape but absent from the plain shape",
      ).toEqual([]);

      const nullabilityMismatches = Object.keys(mcpShape)
        .filter((key) => key in plainShape)
        .filter(
          (key) =>
            acceptsNull(field(mcpShape, key)) !==
            acceptsNull(field(plainShape, key)),
        )
        .map(
          (key) =>
            `${key}: mcp accepts null = ${acceptsNull(field(mcpShape, key))}, plain accepts null = ${acceptsNull(field(plainShape, key))}`,
        );
      expect(nullabilityMismatches).toEqual([]);
    },
  );

  // A pair on the exception list must still name a real, specific reason —
  // this is what keeps the escape hatch from becoming a place to quietly
  // stash a failure with an empty or vague comment.
  it.each(PAIRS.filter((pair) => pair.except))(
    "$entity is a documented, investigated exception",
    ({ except }) => {
      expect(typeof except).toBe("string");
      expect((except as string).length).toBeGreaterThan(20);
    },
  );
});
