import { amount } from "@cubby/schemas/codec";
import { recipeId } from "@cubby/schemas/identifiers";
import { locationCreateInput } from "@cubby/schemas/location";
import {
  allProblemsSchema,
  duplicateUniqueProductSchema,
  emptyLocationSchema,
  ingredientWithPartialCoverageSchema,
  orphanedProductSchema,
  problemsCountSchema,
  productWithBetterUpcDataSchema,
  productWithIslandedMappingsSchema,
  problemRowSchema,
  productWithoutMappingsSchema,
  staleIngredientParseSchema,
} from "@cubby/schemas/problems";
import { productCreateInput } from "@cubby/schemas/product";
import { recipeCreateInput, recipeOut } from "@cubby/schemas/recipe";
import {
  SHORTCODE_PREFIX,
  type ShortcodeType,
  shortcodeSchema,
} from "@cubby/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { mock } from "./mock-schema";

// The load-bearing guarantee: anything we generate must pass its own schema.
const ROUND_TRIP_CORPUS = {
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
  productWithoutMappingsSchema,
  ingredientWithPartialCoverageSchema,
  emptyLocationSchema,
  problemRowSchema,
  productWithIslandedMappingsSchema,
  staleIngredientParseSchema,
  productWithBetterUpcDataSchema,
} satisfies Readonly<Record<string, z.ZodType>>;

const isShortcodeType = (value: string): value is ShortcodeType =>
  value in SHORTCODE_PREFIX;

describe("mock() round-trip", () => {
  for (const [name, schema] of Object.entries(ROUND_TRIP_CORPUS)) {
    it(`generates data that parses for ${name}`, () => {
      const value = mock(schema, { seed: 1 });
      const result = schema.safeParse(value);
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
    const value = mock(orphanedProductSchema, {
      seed: 1,
      overrides: { name: "Pinned Name", manufacturer: "Pinned Mfr" },
    });
    expect(value.name).toBe("Pinned Name");
    expect(value.manufacturer).toBe("Pinned Mfr");
    expect(orphanedProductSchema.safeParse(value).success).toBe(true);
  });

  it("an override that names another union variant does not inherit the generated variant's fields", () => {
    // `gen` always takes option 0; before the schema-aware merge the `complete`
    // base's random `coverage` survived under an `unavailable` override and
    // only Zod's unknown-key stripping hid it. Once `unavailable` declared its
    // own optional `coverage`, the inherited one failed the `covered <= total`
    // refinement.
    const estimate = z.discriminatedUnion("status", [
      z.object({
        status: z.literal("complete"),
        coverage: z.object({ covered: z.number(), total: z.number() }),
      }),
      z.object({
        status: z.literal("unavailable"),
        reason: z.string(),
        coverage: z.object({ covered: z.literal(0) }).optional(),
      }),
    ]);
    const schema = z.object({ totals: z.object({ cost: estimate }) });
    const value = mock(schema, {
      seed: 1,
      overrides: {
        totals: { cost: { status: "unavailable", reason: "no_data" } },
      },
    });
    expect(value.totals.cost).toEqual({
      status: "unavailable",
      reason: "no_data",
    });
  });

  it("array overrides replace wholesale", () => {
    const value = mock(duplicateUniqueProductSchema, {
      seed: 1,
      overrides: { locations: [{ id: "LOC-ABCD", name: "Pantry" }] },
    });
    expect(value.locations).toEqual([{ id: "LOC-ABCD", name: "Pantry" }]);
  });
});

describe("mock() policy", () => {
  it("omits optionals by default but fills them when asked", () => {
    // `upperValue` is optional on `amount`; omitting it satisfies the refine.
    const omitted = mock(amount, { seed: 1 });
    expect(omitted).not.toHaveProperty("upperValue");

    const filled = mock(amount, {
      seed: 1,
      fillOptionals: true,
      overrides: { value: 1, upperValue: 2 },
    });
    expect(filled).toHaveProperty("upperValue");
    // NB: with fillOptionals, `upperValue` and `value` are independent randoms,
    // so a refine like `upperValue > value` is NOT guaranteed — that is why the
    // default policy omits optionals, and why refined fields need an override.
  });
});

describe("mock() regex-constrained strings", () => {
  // Without regex support the generator emitted lorem words for any `.regex()`
  // field, which silently produced fixtures that could never satisfy their own
  // schema — that was a real 16-test failure before this landed.
  it("satisfies the pattern it was built from", () => {
    const cases = [
      z.string().regex(/^PRD-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/),
      z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      z.string().regex(/^[a-f0-9]{8}$/),
      z.string().regex(/^v\d+$/),
      z.string().regex(/^[A-Z]{2,4}$/),
      z.string().regex(/^ab?c*d+$/),
    ];
    for (const schema of cases) {
      const value = mock(z.object({ v: schema }), { seed: 7 }).v;
      expect(
        schema.safeParse(value).success,
        `generated ${JSON.stringify(value)} for ${schema.def.checks?.length ?? 0} check(s)`,
      ).toBe(true);
    }
  });

  it("generates a real shortcode for every entity prefix", () => {
    // The case the cutover actually depends on: `mock(taskOut)` and friends
    // must produce codes their own branded schema accepts.
    for (const entity of Object.keys(SHORTCODE_PREFIX).filter(
      isShortcodeType,
    )) {
      const schema = shortcodeSchema(entity);
      const value = mock(z.object({ code: schema }), { seed: 3 }).code;
      expect(schema.safeParse(value).success, `${entity}: ${value}`).toBe(true);
    }
  });
});
