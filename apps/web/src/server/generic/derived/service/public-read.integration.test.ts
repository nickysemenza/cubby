import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  findOrCreateIngredient,
  readIngredientDetail,
} from "~/server/domains/ingredient/repo/crud";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import {
  readRecipeById,
  updateRecipe,
} from "~/server/domains/recipe/repo/crud";
import { readPublicEntityRows } from "~/server/generic/derived/service/public-read";
import {
  createRecipeFixture,
  createLocationFixture,
  makeLocationInput,
  makeRecipeInput,
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

describe("nested field envelope reads", () => {
  const ctx = withTestDb();

  it("projects Inventory products and compact holding Locations with authoritative assignments", async () => {
    const product = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic nested stock", price: 13 }),
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic nested bin", type: "room" }),
      ctx.actor,
    );
    const raw = await createInventoryEntry(
      ctx.db,
      {
        productId: product.entityId,
        locationId: location.entityId,
        amount: { value: 2, unit: "each" },
        placement: "stock",
      },
      ctx.actor,
    );
    const repeated = await readPublicEntityRows({
      db: ctx.db,
      entity: "inventory",
      projection: "detail",
      rows: Array.from({ length: 20 }, (_, index) => ({
        ...raw,
        product: {
          ...raw.product,
          name: `Synthetic product snapshot ${index}`,
          price: 99,
        },
        location: { ...raw.location, type: "container" },
      })),
    });
    expect(repeated.map((row) => row.product.name)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `Synthetic product snapshot ${index}`,
      ),
    );
    const row = repeated[0];
    expect(row).toBeDefined();
    if (!row) return;
    expect(fieldValueOf(row.product.fields.price)).toBe(13);
    expect(row.product.fields.price.current.assignment).toMatchObject({
      kind: "value",
      value: 13,
    });
    expect(fieldValueOf(row.location.fields.type)).toBe("room");
    expect(row.product).not.toHaveProperty("price");
    expect(row.location).not.toHaveProperty("type");
    expect(row.location).not.toHaveProperty("valuation");
    expect(row.location).not.toHaveProperty("aiDescription");
    expect(row).not.toHaveProperty("fieldResolutions");
  });

  it("projects repeated identities while preserving each nested snapshot", async () => {
    const ingredient = await findOrCreateIngredient(
      ctx.db,
      "Synthetic envelope ingredient",
    );
    await createProductIdentityFixture(
      ctx.db,
      makeProductInput({
        name: "Synthetic envelope product",
        ingredientId: parseShortcodeFor("ingredient", ingredient.shortcode),
        price: 13,
      }),
      ctx.actor,
    );
    // Outside Workers the record read resolves no USDA foods.
    const raw = await readIngredientDetail(
      ctx.db,
      parseEntityId("ingredient", ingredient.id),
    );
    if (!raw) throw new Error("Synthetic ingredient missing");
    const repeated = await readPublicEntityRows({
      db: ctx.db,
      entity: "ingredient",
      projection: "detail",
      rows: Array.from({ length: 20 }, (_, index) => ({
        ...raw,
        product: raw.product.map((product) => ({
          ...product,
          name: `Synthetic snapshot ${index}`,
        })),
      })),
    });
    expect(repeated.map((row) => row.product[0]?.name)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Synthetic snapshot ${index}`),
    );
    expect(repeated[0]?.product[0]).not.toHaveProperty("fieldResolutions");
    expect(repeated[0]?.product[0]).not.toHaveProperty("price");
    const price = repeated[0]?.product[0]?.fields.price;
    expect(price).toMatchObject({
      current: { assignment: { kind: "value", value: 13 } },
    });
    if (!price) return;
    expect(fieldValueOf(price)).toBe(13);
    expect(repeated[0]?.product[0]?.unitMappings).toEqual(
      raw.product[0]?.unitMappings,
    );
  });

  it("projects subrecipes inside section-line unions without expanding their graph", async () => {
    const child = await createRecipeFixture(
      ctx.db,
      { ...makeRecipeInput({ name: "Synthetic nested filling" }), servings: 4 },
      ctx.actor,
    );
    const ingredient = await findOrCreateIngredient(
      ctx.db,
      "Synthetic nested flour",
    );
    const parent = await createRecipeFixture(
      ctx.db,
      makeRecipeInput({
        name: "Synthetic nested pastry",
        sections: [
          {
            name: "Assembly",
            ingredients: [
              {
                type: "ingredient",
                ingredientId: parseShortcodeFor(
                  "ingredient",
                  ingredient.shortcode,
                ),
                recipeId: null,
                amounts: [{ value: 1, unit: "cup" }],
                rawLine: "1 cup synthetic flour",
              },
              {
                type: "recipe",
                recipeId: child.id,
                ingredientId: null,
                amounts: [{ value: 1, unit: "each" }],
                rawLine: "1 synthetic filling",
                modifier: "prepared",
              },
            ],
          },
        ],
      }),
      ctx.actor,
    );
    const raw = await readRecipeById(ctx.db, parent.entityId);
    if (!raw) throw new Error("Synthetic parent recipe is missing");
    await updateRecipe(ctx.db, child.entityId, { servings: 6 }, ctx.actor);
    const repeated = await readPublicEntityRows({
      db: ctx.db,
      entity: "recipe",
      projection: "detail",
      rows: Array.from({ length: 20 }, (_, index) => ({
        ...raw,
        sections: raw.sections.map((section) => ({
          ...section,
          ingredients: section.ingredients.map((line) =>
            line.type === "recipe"
              ? {
                  ...line,
                  recipe: {
                    ...line.recipe,
                    name: `Synthetic filling snapshot ${index}`,
                    servings: 99,
                  },
                }
              : line,
          ),
        })),
      })),
    });
    const snapshots = repeated.map(
      (row) =>
        row.sections[0]?.ingredients.find((line) => line.type === "recipe")
          ?.recipe,
    );
    expect(snapshots.map((snapshot) => snapshot?.name)).toEqual(
      Array.from(
        { length: 20 },
        (_, index) => `Synthetic filling snapshot ${index}`,
      ),
    );
    for (const snapshot of snapshots) {
      if (!snapshot) throw new Error("Nested recipe snapshot is missing");
      expect(snapshot).not.toHaveProperty("sections");
      expect(snapshot).not.toHaveProperty("servings");
      expect(snapshot.fields.servings.current.assignment).toMatchObject({
        kind: "value",
        value: 6,
      });
      expect(fieldValueOf(snapshot.fields.servings)).toBe(6);
    }
    expect(repeated[0]?.sections[0]?.ingredients[0]).toMatchObject({
      type: "ingredient",
      recipe: null,
      rawLine: "1 cup synthetic flour",
    });
    expect(repeated[0]?.sections[0]?.ingredients[1]).toMatchObject({
      rawLine: "1 synthetic filling",
      modifier: "prepared",
    });
  });
});
