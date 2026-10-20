import { describe, expect, it } from "vitest";
import { recipeLineAsInput, recipeSectionOut } from "./recipe-fields";
import { testShortcode } from "./test-support/identifiers";

describe("recipe section projections", () => {
  it("retains legacy read amounts and optional provenance while enforcing positive write amounts", () => {
    // Sharing read declarations must not import positive input constraints or
    // lose editor aliases; projecting a legacy zero amount must still refuse a write.
    const date = new Date("2026-01-01T00:00:00Z");
    const section = recipeSectionOut.parse({
      id: "00000000-0000-4000-8000-000000000001",
      name: null,
      createdAt: date,
      updatedAt: date,
      instructions: [{ instruction: "Mix", extra: true }],
      ingredients: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          type: "ingredient",
          recipe: null,
          ingredient: {
            id: testShortcode("ingredient", "ING-2222"),
            name: "Synthetic flour",
            aliases: ["Flour"],
            createdAt: date,
            updatedAt: date,
          },
          amounts: [{ value: 0, unit: "g" }],
          rawLine: null,
          createdAt: date,
          updatedAt: date,
          extra: true,
        },
      ],
    });
    expect(section.instructions).toEqual([{ instruction: "Mix" }]);
    const line = section.ingredients[0];
    if (!line || line.type !== "ingredient")
      throw new Error("Expected an ingredient line");
    expect(line.ingredient.aliases).toEqual(["Flour"]);
    expect(line.rawLine).toBeNull();
    expect(line.modifier).toBeUndefined();
    expect(line).not.toHaveProperty("extra");
    expect(() => recipeLineAsInput(line)).toThrow(/greater than zero/u);
    expect(
      recipeLineAsInput({ ...line, amounts: [{ value: 1, unit: "g" }] }),
    ).toMatchObject({
      ingredientId: line.ingredient.id,
      recipeId: null,
    });
  });
});
