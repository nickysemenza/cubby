import { amount } from "@cubby/schemas/codec";
import { recipeId } from "@cubby/schemas/identifiers";
import { locationCreateInput } from "@cubby/schemas/location";
import {
  allProblemsSchema,
  duplicateUniqueProductSchema,
  emptyLocationSchema,
  ingredientWithPartialCoverageSchema,
  invalidInventoryAmountSchema,
  invalidUPCSchema,
  orphanedProductSchema,
  problemsCountSchema,
  productWithBetterUpcDataSchema,
  productWithIslandedMappingsSchema,
  productWithNoImagesSchema,
  productWithoutMappingsSchema,
  productWithWrongCategorySchema,
  staleIngredientParseSchema,
} from "@cubby/schemas/problems";
import { productCreateInput } from "@cubby/schemas/product";
import { recipeCreateInput, recipeOut } from "@cubby/schemas/recipe";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { mock } from "./mock-schema";

// The load-bearing guarantee: anything we generate must pass its own schema.
const ROUND_TRIP_CORPUS: Record<string, z.ZodType> = {
  amount,
  recipeId,
  productCreateInput,
  locationCreateInput,
  recipeCreateInput,
  recipeOut,
  allProblemsSchema,
  problemsCountSchema,
  duplicateUniqueProductSchema,
  orphanedProductSchema,
  invalidUPCSchema,
  productWithoutMappingsSchema,
  ingredientWithPartialCoverageSchema,
  invalidInventoryAmountSchema,
  emptyLocationSchema,
  productWithNoImagesSchema,
  productWithWrongCategorySchema,
  productWithIslandedMappingsSchema,
  staleIngredientParseSchema,
  productWithBetterUpcDataSchema,
};

describe("mock() round-trip", () => {
  for (const [name, schema] of Object.entries(ROUND_TRIP_CORPUS)) {
    it(`generates data that parses for ${name}`, () => {
      const value = mock(schema, { seed: 1 });
      const result = schema.safeParse(value);
      if (!result.success) {
        throw new Error(
          `mock(${name}) failed its own schema: ${JSON.stringify(z.treeifyError(result.error), null, 2)}`,
        );
      }
      expect(result.success).toBe(true);
    });
  }
});

describe("mock() determinism", () => {
  it("same seed yields deep-equal output", () => {
    const a = mock(productCreateInput, { seed: 42 });
    const b = mock(productCreateInput, { seed: 42 });
    expect(a).toEqual(b);
  });

  it("different seeds usually differ", () => {
    const a = mock(orphanedProductSchema, { seed: 1 });
    const b = mock(orphanedProductSchema, { seed: 2 });
    expect(a).not.toEqual(b);
  });
});

describe("mock() overrides", () => {
  it("a deep override wins over generated values and still parses", () => {
    const value = mock(invalidUPCSchema, {
      seed: 1,
      overrides: { name: "Pinned Name", issue: "duplicate" },
    });
    expect(value.name).toBe("Pinned Name");
    expect(value.issue).toBe("duplicate");
    expect(invalidUPCSchema.safeParse(value).success).toBe(true);
  });

  it("array overrides replace wholesale", () => {
    const value = mock(duplicateUniqueProductSchema, {
      seed: 1,
      overrides: { locations: [{ id: "loc-1", name: "Pantry" }] },
    });
    expect(value.locations).toEqual([{ id: "loc-1", name: "Pantry" }]);
  });
});

describe("mock() policy", () => {
  it("omits optionals by default but fills them when asked", () => {
    // `upperValue` is optional on `amount`; omitting it satisfies the refine.
    const omitted = mock(amount, { seed: 1 });
    expect(omitted).not.toHaveProperty("upperValue");

    const filled = mock(amount, { seed: 1, fillOptionals: true });
    expect(filled).toHaveProperty("upperValue");
    // NB: with fillOptionals, `upperValue` and `value` are independent randoms,
    // so a refine like `upperValue > value` is NOT guaranteed — that is why the
    // default policy omits optionals, and why refined fields need an override.
  });
});
