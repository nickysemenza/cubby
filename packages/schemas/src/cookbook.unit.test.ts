import { describe, expect, test } from "vitest";
import {
  type CookbookRecipe,
  cookbookRecipeToCompact,
  cookbookRecipesSchema,
} from "./cookbook";

const baseRecipe = (
  overrides: Partial<CookbookRecipe> = {},
): CookbookRecipe => ({
  meta: { title: "Pancakes" },
  sections: [
    { name: undefined, ingredients: ["2 cups flour"], instructions: [] },
  ],
  source: "/books/Salt Fat Acid Heat.epub",
  url: "/books/Salt Fat Acid Heat.epub#ch3.xhtml",
  references: [],
  ...overrides,
});

describe("cookbookRecipeToCompact", () => {
  test("maps title to name and passes sections through", () => {
    const compact = cookbookRecipeToCompact(
      baseRecipe({
        sections: [
          {
            name: "For the batter",
            ingredients: ["2 cups flour", "2 eggs"],
            instructions: ["Mix", "Cook"],
          },
        ],
      }),
    );

    expect(compact.name).toBe("Pancakes");
    expect(compact.sections).toHaveLength(1);
    expect(compact.sections[0]).toEqual({
      name: "For the batter",
      ingredients: ["2 cups flour", "2 eggs"],
      instructions: ["Mix", "Cook"],
    });
  });

  test("sanitizes short/blank section names to null", () => {
    const compact = cookbookRecipeToCompact(
      baseRecipe({
        sections: [
          { name: "A", ingredients: ["x"], instructions: [] },
          { name: "  ", ingredients: ["y"], instructions: [] },
          { name: undefined, ingredients: ["z"], instructions: [] },
        ],
      }),
    );

    expect(compact.sections.map((s) => s.name)).toEqual([null, null, null]);
  });

  test("omits url/meta and image; yield absent without a parsed value", () => {
    const compact = cookbookRecipeToCompact(
      baseRecipe({ meta: { title: "Loaf", recipe_yield: "Makes 1 loaf" } }),
    );

    expect(compact.meta).toBeUndefined();
    expect(compact.recipe_yield).toBeUndefined();
    expect(compact.servings).toBeUndefined();
    expect(compact.image).toBeUndefined();
  });

  test("passes through a parsed yield (parsed by the caller via WASM)", () => {
    const compact = cookbookRecipeToCompact(baseRecipe(), {
      recipe_yield: { value: 12, unit: "pancakes" },
      servings: undefined,
    });

    expect(compact.recipe_yield).toEqual({ value: 12, unit: "pancakes" });
    expect(compact.servings).toBeUndefined();
  });

  test("preserves multiple sections in order", () => {
    const compact = cookbookRecipeToCompact(
      baseRecipe({
        sections: [
          { name: "Dough", ingredients: ["flour"], instructions: [] },
          { name: "Filling", ingredients: ["apples"], instructions: [] },
        ],
      }),
    );

    expect(compact.sections.map((s) => s.name)).toEqual(["Dough", "Filling"]);
  });
});

describe("cookbookRecipesSchema", () => {
  test("accepts a food-cli --json array (instructions default to [])", () => {
    const result = cookbookRecipesSchema.safeParse([
      {
        meta: { title: "Soup" },
        sections: [{ ingredients: ["1 onion"] }],
        source: "book.epub",
      },
    ]);

    expect(result.success).toBe(true);
    expect(result.data?.[0]?.sections[0]?.instructions).toEqual([]);
  });

  test("rejects a section missing ingredients", () => {
    const result = cookbookRecipesSchema.safeParse([
      { meta: { title: "Bad" }, sections: [{ instructions: ["step"] }] },
    ]);

    expect(result.success).toBe(false);
  });

  test("references default to [] and parse cross-recipe pointers", () => {
    const result = cookbookRecipesSchema.safeParse([
      // no references key → defaults to []
      { meta: { title: "Plain" }, sections: [{ ingredients: ["1 egg"] }] },
      {
        meta: { title: "Galette" },
        sections: [{ ingredients: ["1 recipe The Only Piecrust"] }],
        references: [
          {
            title: "The Only Piecrust",
            line: "1 recipe The Only Piecrust",
            confidence: "title_match",
          },
        ],
      },
    ]);

    expect(result.success).toBe(true);
    expect(result.data?.[0]?.references).toEqual([]);
    expect(result.data?.[1]?.references[0]?.title).toBe("The Only Piecrust");
    expect(result.data?.[1]?.references[0]?.confidence).toBe("title_match");
  });

  test("rejects an invalid reference confidence", () => {
    const result = cookbookRecipesSchema.safeParse([
      {
        meta: { title: "X" },
        sections: [{ ingredients: ["a"] }],
        references: [{ title: "Y", line: "1 Y", confidence: "guess" }],
      },
    ]);

    expect(result.success).toBe(false);
  });
});
