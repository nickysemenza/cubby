import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { describe, expect, it } from "vitest";

import {
  readDisplayReferenceField,
  readReferenceField,
} from "./entity-references";

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

// Display can diverge from assignment intent: inheritance changes the target,
// and allocated references can have multiple targets or unresolved shares.
describe("effective reference display", () => {
  it("uses effective allocation labels without overwriting the stored assignment", () => {
    const row = {
      spendingCategoryId: "SPC-4K7M",
      spendingCategoryName: "Stored category",
      fieldResolutions: {
        spendingCategoryId: {
          mode: "allocated",
          storedValue: "SPC-4K7M",
          value: null,
          fallbackValue: null,
          source: "Principal line allocation",
          sourceEntity: null,
          matchesFallback: false,
          canReset: true,
        },
      },
      spendingCategoryAllocations: [
        {
          spendingCategoryId: "SPC-7M4K",
          spendingCategoryName: "Supplies",
          amount: 2,
          incomplete: false,
        },
        {
          spendingCategoryId: null,
          spendingCategoryName: null,
          amount: 1,
          incomplete: true,
        },
      ],
    };
    const reference = field("expense", "spendingCategoryId");
    expect(readDisplayReferenceField(row, reference)).toEqual({
      entity: "spendingCategory",
      items: [{ id: "SPC-7M4K", name: "Supplies", amount: 2 }],
      unclassifiedAllocations: [{ amount: 1 }],
      incomplete: true,
    });
    expect(readReferenceField(row, reference)?.items[0]?.id).toBe("SPC-4K7M");
  });

  it("never puts a stored target's name on a different effective target", () => {
    const row = {
      projectId: "PRJ-4K7M",
      projectName: "Stored project",
      fieldResolutions: {
        projectId: {
          mode: "inherit",
          storedValue: "PRJ-4K7M",
          value: "PRJ-7M4K",
          fallbackValue: "PRJ-7M4K",
          source: "Purchase",
          sourceEntity: null,
          matchesFallback: false,
          canReset: true,
        },
      },
      projectAllocations: [
        {
          projectId: "PRJ-7M4K",
          projectName: "Effective project",
          incomplete: false,
        },
      ],
    };
    expect(
      readDisplayReferenceField(row, field("expense", "projectId")),
    ).toEqual({
      entity: "project",
      items: [{ id: "PRJ-7M4K", name: "Effective project" }],
    });
  });
});

it("keeps an inherited effective target out of the stored picker baseline", () => {
  const row = {
    projectId: "PRJ-4K7M",
    projectName: "Inherited project",
    fieldResolutions: {
      projectId: {
        mode: "inherit",
        storedValue: null,
        value: "PRJ-4K7M",
        fallbackValue: "PRJ-4K7M",
        source: "Purchase",
        sourceEntity: null,
        matchesFallback: true,
        canReset: false,
      },
    },
  };
  const reference = field("expense", "projectId");
  expect(readReferenceField(row, reference)?.items).toEqual([]);
  expect(readDisplayReferenceField(row, reference)?.items).toEqual([
    { id: "PRJ-4K7M", name: "Inherited project" },
  ]);
});
