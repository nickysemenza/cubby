import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { describe, expect, it } from "vitest";

import { readReferenceField } from "./entity-references";

const field = (entity: keyof typeof entityFieldModels, key: string) => {
  const found = entityFieldModels[entity].fields.find((f) => f.key === key);
  if (!found) throw new Error(`${entity}.${key} is not a declared field`);
  return found;
};

describe("readReferenceField", () => {
  it("links a shortcode-bearing reference and labels it from the sibling name", () => {
    expect(
      readReferenceField(
        { projectId: "PRJ-DECK", projectName: "Deck rebuild" },
        field("task", "projectId"),
      ),
    ).toEqual({
      entity: "project",
      items: [{ id: "PRJ-DECK", name: "Deck rebuild" }],
    });
  });

  it("links an expanded reference carried under its read key", () => {
    expect(
      readReferenceField(
        {
          product: { id: "PRD-TOTE", name: "Fixture tote" },
        },
        field("location", "productId"),
      ),
    ).toEqual({
      entity: "product",
      items: [{ id: "PRD-TOTE", name: "Fixture tote" }],
    });
  });

  // Regression: recipe `meals` references meal but reads `mealCount`; parsing
  // that number as shortcodes crashed every ingredient page listing a recipe.
  it("yields no reference for a count-bearing read key so it renders as a scalar", () => {
    expect(
      readReferenceField({ mealCount: 3 }, field("recipe", "meals")),
    ).toBeNull();
  });
});
