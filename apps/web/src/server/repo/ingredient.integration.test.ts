import { unsafeIngredientId } from "@cubby/schemas/identifiers";
import type { IngredientFilters } from "@cubby/schemas/ingredient";
import { count, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { ingredient, recipe } from "~/server/db/schema";
import { upsertImportRecipe } from "~/server/repo/import-recipe-convert";
import { createRecipe, deleteRecipes } from "~/server/repo/recipe";
import { getDb, withTransaction } from "./database-helpers";
import {
  createIngredient,
  enrichmentWorkbenchIngredients,
  findOrCreateIngredient,
  ingredientList,
  mergeIngredients,
  resolveOrCreateIngredients,
} from "./ingredient";
import { createProduct, deleteProducts } from "./product";
import {
  ingredientRef,
  makeImportRecipe,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";

describe("ingredient", () => {
  const ctx = withTestDb();

  it("ingredient upsert with aliases", async () => {
    await withTransaction(ctx.db, async (tx) => {
      await findOrCreateIngredient(tx, "alias_1");
      await findOrCreateIngredient(tx, "test", ["alias_1"]);
    });
    const [result] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(result!.count).toEqual(1);
  });
  it("concurrent findOrCreate of the same new ingredient yields one row, no 500", async () => {
    // Cross-request race, deterministically forced. Two separate transactions
    // both create the SAME new ingredient:
    //   tx1: SELECT (miss) -> INSERT (uncommitted, holds the row lock)
    //   tx2: SELECT (miss, READ COMMITTED can't see tx1's row) -> INSERT BLOCKS
    //   tx1 commits -> tx2's INSERT unblocks
    // Before the fix tx2's INSERT raised a unique violation that aborted the txn
    // (-> 500). With ON CONFLICT DO NOTHING it raises nothing, returns no row,
    // and the re-SELECT finds tx1's committed row.
    const name = "racy salt";

    let releaseTx1!: () => void;
    const tx1Committed = new Promise<void>((resolve) => {
      releaseTx1 = resolve;
    });

    // tx1 runs findOrCreate, then holds the transaction open (lock held) until
    // we release it below.
    const tx1 = withTransaction(ctx.db, async (tx) => {
      const row = await findOrCreateIngredient(tx, name);
      await tx1Committed;
      return row;
    });

    // Let tx1 reach (and hold) its uncommitted INSERT before tx2 starts.
    await new Promise((r) => setTimeout(r, 100));

    // tx2 races the same name; its INSERT will block on tx1's lock.
    const tx2 = withTransaction(ctx.db, async (tx) =>
      findOrCreateIngredient(tx, name),
    );

    // Give tx2 time to reach its blocked INSERT, then commit tx1 to unblock it.
    await new Promise((r) => setTimeout(r, 100));
    releaseTx1();

    const [a, b] = await Promise.all([tx1, tx2]);

    // Both callers resolve to the same surviving row, no error thrown.
    expect(a.id).toEqual(b.id);

    // Exactly one row exists.
    const [result] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(result!.count).toEqual(1);
  });
  it("dedupes case-variant names to one row", async () => {
    // The matcher is case-insensitive (lower(name)); the unique index now agrees
    // (lower(name)), so "Flour" then "flour" resolves to the same row — the
    // second find matches the first and never inserts.
    const flour = await findOrCreateIngredient(ctx.db, "Flour");
    const flourLower = await findOrCreateIngredient(ctx.db, "flour");
    expect(flourLower.id).toEqual(flour.id);
    expect(flourLower.name).toEqual("Flour"); // first writer's casing is kept

    const [result] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(result!.count).toEqual(1);
  });

  it("concurrent case-variant creates dedupe to one row", async () => {
    // Same race as above, but the two requests differ only in case. Before the
    // lower(name) index, "Flour" and "flour" both inserted (the exact-name index
    // didn't see them as equal). Now the loser's INSERT conflicts on lower(name)
    // and recovers onto the winner.
    let releaseWinner!: () => void;
    const winnerCommitted = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });

    let winnerId = "";
    const winner = withTransaction(ctx.db, async (tx) => {
      const row = await findOrCreateIngredient(tx, "Flour");
      winnerId = row.id;
      await winnerCommitted;
      return row;
    });

    await new Promise((r) => setTimeout(r, 100));
    const loser = findOrCreateIngredient(ctx.db, "flour"); // different case, races
    await new Promise((r) => setTimeout(r, 100));
    releaseWinner();

    const [, loserRow] = await Promise.all([winner, loser]);
    expect(loserRow.id).toEqual(winnerId);

    const [result] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(result!.count).toEqual(1);
  });

  it("matches aliases case-insensitively", async () => {
    // Alias matching is now case-insensitive too (lower(alias)), consistent with
    // name matching: looking up "scallion" finds the ingredient whose alias is
    // "Scallion" and returns it rather than creating a duplicate.
    const allium = await findOrCreateIngredient(ctx.db, "Allium", ["Scallion"]);
    const viaAlias = await findOrCreateIngredient(ctx.db, "scallion");
    expect(viaAlias.id).toEqual(allium.id);

    const [result] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(result!.count).toEqual(1);
  });

  it("does not append casing-variant aliases", async () => {
    // Alias dedup is case-insensitive: re-adding "scallion" when the ingredient
    // already has alias "Scallion" is a no-op, not a second array entry.
    const first = await findOrCreateIngredient(ctx.db, "Allium", ["Scallion"]);
    expect(first.aliases).toEqual(["Scallion"]);

    const second = await findOrCreateIngredient(ctx.db, "Allium", ["scallion"]);
    expect(second.id).toEqual(first.id);
    expect(second.aliases).toEqual(["Scallion"]); // unchanged, no "scallion" added
  });

  it("resolveOrCreateIngredients: matches existing, creates misses, in order", async () => {
    // Seed one existing ingredient with an alias.
    const allium = await findOrCreateIngredient(ctx.db, "Allium", ["Scallion"]);

    const result = await resolveOrCreateIngredients(ctx.db, [
      "Allium", // exact existing
      "scallion", // existing via alias (case-insensitive)
      "jasmine rice", // new
    ]);

    // One entry per input name, in order.
    expect(result.map((r) => r.name)).toEqual([
      "Allium",
      "scallion",
      "jasmine rice",
    ]);

    expect(result[0]).toMatchObject({
      id: allium.id,
      matched: true,
      created: false,
    });
    expect(result[1]).toMatchObject({
      id: allium.id,
      matched: true,
      created: false,
    });
    expect(result[2]!.matched).toBe(false);
    expect(result[2]!.created).toBe(true);

    // Only the one new row was added (Allium + jasmine rice = 2 total).
    const [rows] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(rows!.count).toEqual(2);
  });

  it("resolveOrCreateIngredients: idempotent on re-run and dedupes casing within a call", async () => {
    const first = await resolveOrCreateIngredients(ctx.db, [
      "Soy Sauce",
      "soy sauce", // casing-variant duplicate within the same call
    ]);
    // Both input names resolve to the same row; the second is a same-call match.
    expect(first[0]!.id).toEqual(first[1]!.id);
    expect(first[0]!.created).toBe(true);

    const [afterFirst] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(afterFirst!.count).toEqual(1);

    // Re-running resolves everything as an existing match — no new rows.
    const second = await resolveOrCreateIngredients(ctx.db, ["soy sauce"]);
    expect(second[0]!.id).toEqual(first[0]!.id);
    expect(second[0]).toMatchObject({ matched: true, created: false });

    const [afterSecond] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(afterSecond!.count).toEqual(1);
  });

  it("ingredient merging works", async () => {
    await upsertImportRecipe(
      makeImportRecipe({
        meta: { title: "egg recipe" },
        sections: [
          {
            instructions: ["crack egg"],
            ingredients: ["eggs"],
          },
        ],
      }),
      ctx.db,
      ctx.actor,
    );
    const a = await findOrCreateIngredient(ctx.db, "egg");
    const b = await findOrCreateIngredient(ctx.db, "eggs");
    const c = await findOrCreateIngredient(ctx.db, "large brown eggs", [
      "large eggs",
    ]);
    const [resultAfterUpsert] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(resultAfterUpsert!.count).toEqual(3);

    // Simulate a freshly-costed recipe so the merge's in-tx stale-marking is
    // observable (otherwise a brand-new recipe is already null).
    await getDb(ctx.db)
      .update(recipe)
      .set({ totalsComputedAt: new Date() })
      .where(eq(recipe.name, "egg recipe"));

    const summary = await mergeIngredients(ctx.db, a.id, [b.id, c.id]);
    const [resultAfterMerge] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(resultAfterMerge!.count).toEqual(1);

    const updatedIngredient = await getDb(ctx.db).query.ingredient.findFirst({
      where: eq(ingredient.id, a.id),
    });
    expect(updatedIngredient).toBeDefined();
    expect(updatedIngredient!.aliases).toContain(b.name);
    expect(updatedIngredient!.aliases).toContain(c.name);
    expect(updatedIngredient!.aliases).toContain("large eggs");

    // Structured summary: both aliases absorbed, the one recipe using "eggs"
    // moved, nothing-silently-nothing.
    expect(summary.deletedIds).toEqual(expect.arrayContaining([b.id, c.id]));
    expect(summary.deletedIds).toHaveLength(2);
    expect(summary.recipesMoved).toEqual(1);
    expect(summary.aliasesAdded).toEqual(
      expect.arrayContaining([b.name, c.name, "large eggs"]),
    );

    // Correctness floor: the absorbed recipe is marked stale in the same tx.
    const movedRecipe = await getDb(ctx.db).query.recipe.findFirst({
      where: eq(recipe.name, "egg recipe"),
    });
    expect(movedRecipe!.totalsComputedAt).toBeNull();
    expect(summary.affectedRecipeIds).toContain(movedRecipe!.id);
  });

  it("merge rejects a self-merge without deleting the target", async () => {
    const a = await findOrCreateIngredient(ctx.db, "self target");
    const b = await findOrCreateIngredient(ctx.db, "self alias");

    await expect(mergeIngredients(ctx.db, a.id, [a.id, b.id])).rejects.toThrow(
      /itself/i,
    );

    // Target (and alias) untouched — the old code would have hard-deleted `a`.
    const [survivors] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(survivors!.count).toEqual(2);
  });

  it("merge fails loud on an unknown alias id (no silent no-op)", async () => {
    const a = await findOrCreateIngredient(ctx.db, "keeper");
    const bogus = unsafeIngredientId("00000000-0000-0000-0000-000000000000");

    await expect(mergeIngredients(ctx.db, a.id, [bogus])).rejects.toThrow(
      /not found/i,
    );

    // Nothing changed: the survivor still exists, gained no aliases.
    const keeper = await getDb(ctx.db).query.ingredient.findFirst({
      where: eq(ingredient.id, a.id),
    });
    expect(keeper).toBeDefined();
    expect(keeper!.aliases).toHaveLength(0);
  });

  it("merge marks recipes ALREADY using the target stale (moved products change its cost)", async () => {
    // A recipe uses the target directly; the alias contributes a product (no
    // recipe of its own). Moving that product onto the target can change the
    // target's cost, so the target-using recipe must be recomputed — even though
    // none of its lines "moved".
    await upsertImportRecipe(
      makeImportRecipe({
        meta: { title: "pepper recipe" },
        sections: [{ instructions: ["grind"], ingredients: ["pepper"] }],
      }),
      ctx.db,
      ctx.actor,
    );
    const target = await findOrCreateIngredient(ctx.db, "pepper");
    const alias = await findOrCreateIngredient(ctx.db, "peppercorns");
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "Tellicherry peppercorns",
        manufacturer: "test",
        ingredientId: alias.id,
      }),
      ctx.actor,
    );
    await getDb(ctx.db)
      .update(recipe)
      .set({ totalsComputedAt: new Date() })
      .where(eq(recipe.name, "pepper recipe"));

    const summary = await mergeIngredients(ctx.db, target.id, [alias.id]);

    // No recipe used the alias, so nothing "moved"…
    expect(summary.recipesMoved).toEqual(0);
    expect(summary.productsMoved).toEqual(1);
    // …but the target-using recipe is in the recompute set and marked stale.
    const pepperRecipe = await getDb(ctx.db).query.recipe.findFirst({
      where: eq(recipe.name, "pepper recipe"),
    });
    expect(summary.affectedRecipeIds).toContain(pepperRecipe!.id);
    expect(pepperRecipe!.totalsComputedAt).toBeNull();
  });

  it("merge dryRun reports counts and writes nothing", async () => {
    const a = await findOrCreateIngredient(ctx.db, "dry keeper");
    const b = await findOrCreateIngredient(ctx.db, "dry alias");

    const summary = await mergeIngredients(ctx.db, a.id, [b.id], {
      dryRun: true,
    });
    expect(summary.deletedIds).toEqual([b.id]);
    expect(summary.aliasesAdded).toContain(b.name);

    // No write: both ingredients still exist, target gained no aliases.
    const [after] = await getDb(ctx.db)
      .select({ count: count() })
      .from(ingredient);
    expect(after!.count).toEqual(2);
    const keeper = await getDb(ctx.db).query.ingredient.findFirst({
      where: eq(ingredient.id, a.id),
    });
    expect(keeper!.aliases).toHaveLength(0);
  });

  // Regression: the lean workbench fetch uses a relational query with raw-SQL
  // `extras` (recipeCount/cookbookOnly correlated subqueries) — exercise it end to
  // end so a Drizzle codegen break can't slip past typecheck. Replaced the 24 MB
  // full-relation fetch that made the workbench ~40s.
  it("enrichmentWorkbenchIngredients: recipe-used only, with recipeCount + cookbookOnly + products", async () => {
    const used = await createIngredient(
      ctx.db,
      { name: "flour", aliases: [] },
      ctx.actor,
    );
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "Test flour",
        manufacturer: "test",
        ingredientId: used.id,
      }),
      ctx.actor,
    );
    await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Web Recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(used.id)],
          },
        ],
      }),
      ctx.actor,
    );
    // Never used in a recipe → must be excluded by the recipe-used filter.
    await createIngredient(ctx.db, { name: "orphan", aliases: [] }, ctx.actor);

    const rows = await enrichmentWorkbenchIngredients(ctx.db);

    const flour = rows.find((r) => r.id === used.id);
    expect(flour).toBeDefined();
    expect(flour!.recipeCount).toBe(1);
    // A plain web recipe isn't book-sourced, so bool_and(...) → false.
    expect(flour!.cookbookOnly).toBe(false);
    expect(flour!.product).toHaveLength(1);
    expect(flour!.product[0]!.name).toBe("Test flour");
    // Every returned row is recipe-used; the orphan is absent.
    expect(rows.every((r) => r.recipeCount > 0)).toBe(true);
    expect(rows.some((r) => r.name === "orphan")).toBe(false);
  });

  // Regression: the ingredient list is lean — `appearsInRecipes` is {id,name}
  // refs (count + first pill), NOT the full recipe bodies / recipeUsages the old
  // `relations.ingredient.full` shipped (the over-fetch).
  it("ingredientList: appearsInRecipes is lean {id,name} refs, no recipe bodies", async () => {
    const used = await createIngredient(
      ctx.db,
      { name: "flour", aliases: [] },
      ctx.actor,
    );
    const recipe = await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Web Recipe",
        sections: [
          {
            instructions: [{ instruction: "Mix" }],
            ingredients: [ingredientRef(used.id)],
          },
        ],
      }),
      ctx.actor,
    );

    const { data } = await ingredientList(
      ctx.db,
      {},
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    const flour = data.find((i) => i.id === used.id)!;
    expect(flour).toBeDefined();
    expect(flour.appearsInRecipes).toEqual([
      { id: recipe.id, name: "Web Recipe" },
    ]);
    // Lean: no per-usage recipe bodies, no recipeUsages.
    expect(flour).not.toHaveProperty("recipeUsages");
    expect(flour.appearsInRecipes[0]).not.toHaveProperty("sections");
  });

  // Regression: `productPresenceFilter` replaced the old boolean
  // `missingProductsOnly` param — "has" and "none" must partition ingredients
  // by whether they have at least one linked product, and the count returned
  // alongside the page must match (a plain leftJoin+count() over-counts "has"
  // once an ingredient has more than one product; the fix groups by ingredient
  // id before counting).
  it("ingredientList: productPresenceFilter partitions has/none and reports an accurate count", async () => {
    const withProducts = await createIngredient(
      ctx.db,
      { name: "presence-has flour", aliases: [] },
      ctx.actor,
    );
    const withoutProducts = await createIngredient(
      ctx.db,
      { name: "presence-none sugar", aliases: [] },
      ctx.actor,
    );
    // Two live products on the same ingredient - the case that would trip up
    // an ungrouped count() on the "has" branch.
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "Presence Product A",
        ingredientId: withProducts.id,
      }),
      ctx.actor,
    );
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "Presence Product B",
        ingredientId: withProducts.id,
      }),
      ctx.actor,
    );

    const { data: hasRows, count: hasCount } = await ingredientList(
      ctx.db,
      { productPresenceFilter: "has" },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(hasRows.some((i) => i.id === withProducts.id)).toBe(true);
    expect(hasRows.some((i) => i.id === withoutProducts.id)).toBe(false);
    expect(hasCount).toBe(hasRows.length);

    const { data: noneRows } = await ingredientList(
      ctx.db,
      { productPresenceFilter: "none" },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(noneRows.some((i) => i.id === withoutProducts.id)).toBe(true);
    expect(noneRows.some((i) => i.id === withProducts.id)).toBe(false);
  });

  // Regression: the presence join must carry notDeleted(product) — an
  // ingredient whose only product is soft-deleted counts as "none", not "has".
  it("ingredientList: productPresenceFilter treats soft-deleted products as absent", async () => {
    const orphaned = await createIngredient(
      ctx.db,
      { name: "presence-softdel oats", aliases: [] },
      ctx.actor,
    );
    const doomed = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Presence Product Softdel",
        ingredientId: orphaned.id,
      }),
      ctx.actor,
    );
    await deleteProducts(ctx.db, [doomed.id], ctx.actor);

    const { data: hasRows } = await ingredientList(
      ctx.db,
      { productPresenceFilter: "has" },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(hasRows.some((i) => i.id === orphaned.id)).toBe(false);

    const { data: noneRows, count: noneCount } = await ingredientList(
      ctx.db,
      { productPresenceFilter: "none" },
      [{ orderBy: "name", direction: "asc" }],
      { pageIndex: 0, pageSize: 50 },
    );
    expect(noneRows.some((i) => i.id === orphaned.id)).toBe(true);
    expect(noneCount).toBe(noneRows.length);
  });

  describe("ingredientList: recipePresenceFilter", () => {
    const listWith = (filters: IngredientFilters) =>
      ingredientList(ctx.db, filters, [{ orderBy: "name", direction: "asc" }], {
        pageIndex: 0,
        pageSize: 50,
      });

    it("partitions used from orphaned ingredients", async () => {
      const used = await createIngredient(
        ctx.db,
        { name: "recipe-presence used", aliases: [] },
        ctx.actor,
      );
      const orphan = await createIngredient(
        ctx.db,
        { name: "recipe-presence orphan", aliases: [] },
        ctx.actor,
      );
      await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Recipe Presence Recipe",
          sections: [{ ingredients: [ingredientRef(used.id)] }],
        }),
        ctx.actor,
      );

      const has = await listWith({ recipePresenceFilter: "has" });
      expect(has.data.map((i) => i.id)).toContain(used.id);
      expect(has.data.map((i) => i.id)).not.toContain(orphan.id);
      expect(has.count).toBe(has.data.length);

      const none = await listWith({ recipePresenceFilter: "none" });
      expect(none.data.map((i) => i.id)).toContain(orphan.id);
      expect(none.data.map((i) => i.id)).not.toContain(used.id);
    });

    /**
     * The subquery walks RecipeSectionIngredient → RecipeSection → Recipe, and
     * must guard `deletedAt` at EVERY level. Deleting the recipe soft-deletes
     * the whole chain, so this pins that a one-table subquery (which would
     * still see the live-looking join rows) isn't enough — and keeps the filter
     * agreeing with the `appearsInRecipes` cell, which reads 0 here.
     */
    it("a soft-deleted recipe leaves its ingredient orphaned", async () => {
      const stranded = await createIngredient(
        ctx.db,
        { name: "recipe-presence stranded", aliases: [] },
        ctx.actor,
      );
      const doomed = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Doomed Recipe",
          sections: [{ ingredients: [ingredientRef(stranded.id)] }],
        }),
        ctx.actor,
      );
      await deleteRecipes(ctx.db, [doomed.id], ctx.actor);

      const has = await listWith({ recipePresenceFilter: "has" });
      expect(has.data.map((i) => i.id)).not.toContain(stranded.id);

      const none = await listWith({ recipePresenceFilter: "none" });
      const row = none.data.find((i) => i.id === stranded.id);
      expect(row).toBeDefined();
      expect(row?.appearsInRecipes).toEqual([]);
    });
  });
});
