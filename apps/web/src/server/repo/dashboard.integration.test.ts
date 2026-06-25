import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { getDashboardEntityCounts } from "./dashboard";
import { findOrCreateLocationByName } from "./location";
import { createIngredients } from "./repo.fixtures";

// The count query is one statement of six scalar COUNT(*) subqueries (raw SQL),
// so these guard that it executes against Postgres and applies each table's
// filter — in particular that the ingredient count uses standalone rows only
// (`recipeId IS NULL`), matching `ingredientList`.
describe("getDashboardEntityCounts", () => {
  const ctx = withTestDb();

  it("returns all-zero counts on an empty database", async () => {
    expect(await getDashboardEntityCounts(ctx.db)).toEqual({
      products: 0,
      recipes: 0,
      ingredients: 0,
      locations: 0,
      inventory: 0,
      images: 0,
    });
  });

  it("counts non-deleted entities per table", async () => {
    await createIngredients(ctx.db, ["Flour", "Sugar"], ctx.actor);
    await findOrCreateLocationByName(ctx.db, "Pantry", null, "room");

    const counts = await getDashboardEntityCounts(ctx.db);
    expect(counts.ingredients).toBe(2);
    expect(counts.locations).toBe(1);
    expect(counts.products).toBe(0);
    expect(counts.recipes).toBe(0);
    expect(counts.inventory).toBe(0);
    expect(counts.images).toBe(0);
  });
});
