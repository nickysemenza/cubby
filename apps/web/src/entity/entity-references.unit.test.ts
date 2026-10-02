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

  it("links a nested reference when the storage field has no read key", () => {
    expect(
      readReferenceField(
        {
          location: { id: "LOC-WORK", name: "Workshop" },
        },
        field("inventory", "locationId"),
      ),
    ).toEqual({
      entity: "location",
      items: [{ id: "LOC-WORK", name: "Workshop" }],
    });
  });

  // A count under a relation field must not be parsed as shortcodes.
  it("yields no reference for a count-bearing read key so it renders as a scalar", () => {
    expect(
      readReferenceField({ meals: 3 }, field("recipe", "meals")),
    ).toBeNull();
  });
});
