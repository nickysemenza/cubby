import { and, desc, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestTRPCContext } from "~/server/api/trpc";
import {
  auditLog,
  mealRecipe,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { upsertCookbook } from "./cookbook";
import { getDb, notDeleted } from "./database-helpers";
import { deleteMeals, getMealByID } from "./meal";
import {
  deleteRecipes,
  getRecipeByID,
  recipeList,
  updateRecipe,
  upsertCookbookRecipe,
  upsertNotionRecipe,
  upsertRecipe,
} from "./recipe";
import type { RecipeFilters } from "./recipe/internal-types";
import {
  createIngredientFixture as createIngredient,
  createMealFixture as createMeal,
  createProductFixture as createProduct,
  createRecipeFixture as createRecipe,
  ingredientRef,
  makeProductInput,
  makeRecipeInput,
} from "./repo.fixtures";

// Direct repo-layer tests for recipe/crud.ts: the soft-delete cascade + audit
// trail, the keyed upsert variants, and updateRecipe's section replacement +
// audit diff. (Cookbook upsert idempotency / two-book distinctness already live
// in recipe-cookbook-upsert.integration.test.ts; this file covers the rest.)

describe("recipe crud repo", () => {
  const ctx = withTestDb();
  let flourCode: IngredientShortcode;
  beforeEach(async () => {
    const flour = await createIngredient(
      ctx.db,
      { name: "Flour", aliases: [] },
      ctx.actor,
    );
    flourCode = flour.id;
  });

  const recipeWith = (name: string, ingredientId: string) =>
    createRecipe(
      ctx.db,
      makeRecipeInput({
        name,
        sections: [
          {
            name: "Main",
            instructions: [{ instruction: "Mix" }],
            ingredients: [
              ingredientRef(ingredientId, {
                amounts: [{ value: 2, unit: "cup" }],
              }),
            ],
          },
        ],
      }),
      ctx.actor,
    );

  describe("deleteRecipes", () => {
    it("soft-deletes the recipe and cascades to its sections and ingredients", async () => {
      const recipe = await recipeWith("Doomed", flourCode);
      const sectionId = recipe.sections[0]!.id;

      await deleteRecipes(ctx.db, [recipe.entityId], ctx.actor);

      // Excluded from reads.
      expect(await getRecipeByID(ctx.db, recipe.entityId)).toBeNull();

      // Section + ingredient rows still exist but are soft-deleted (excluded by notDeleted).
      const liveSections = await getDb(ctx.db)
        .select({ id: recipeSection.id })
        .from(recipeSection)
        .where(
          and(
            eq(recipeSection.recipeId, recipe.entityId),
            notDeleted(recipeSection),
          ),
        );
      expect(liveSections).toHaveLength(0);

      const liveIngredients = await getDb(ctx.db)
        .select({ id: recipeSectionIngredient.id })
        .from(recipeSectionIngredient)
        .where(
          and(
            eq(recipeSectionIngredient.recipeSectionId, sectionId),
            notDeleted(recipeSectionIngredient),
          ),
        );
      expect(liveIngredients).toHaveLength(0);
    });

    it("writes a delete audit row with cascade counts", async () => {
      const recipe = await recipeWith("Audited", flourCode);
      await deleteRecipes(ctx.db, [recipe.entityId], ctx.actor);

      const [entry] = await getDb(ctx.db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityId, recipe.entityId),
            eq(auditLog.action, "delete"),
          ),
        )
        .limit(1);

      expect(entry).toBeDefined();
      expect(entry?.changes?.cascadedSections).toEqual({ from: 1, to: 0 });
      expect(entry?.changes?.cascadedIngredients).toEqual({ from: 1, to: 0 });
    });

    // Regression guard: deleteRecipes now soft-deletes the recipe's live
    // MealRecipe rows (and counts them into the audit trail as
    // cascadedMealRecipes) in the SAME transaction as the recipe delete — a
    // deleted recipe used to keep rendering inside any meal it was planned
    // into, and dbMealToAPI (repo/meal/helpers.ts) kept summing its stale
    // persisted totals into the rollup with pending:false, i.e. a wrong number
    // that reads as trustworthy.
    it("soft-deletes the MealRecipe link and drops the recipe's contribution from the meal's rollup", async () => {
      // 1 lb = $4 is a clean weight->money mapping the costing engine can
      // actually convert (mirrors RecipeCostingService's "cascade flour" case),
      // so costTotal lands on an exact, assertable number instead of "some
      // positive value".
      await createProduct(
        ctx.db,
        makeProductInput({
          name: "Meal Flour Product",
          ingredientId: flourCode,
          unitMappings: [
            {
              a: { value: 1, unit: "lb" },
              b: { value: 4, unit: "dollar" },
              source: "test",
            },
          ],
        }),
        ctx.actor,
      );
      const recipe = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Costed Meal Recipe",
          sections: [
            {
              instructions: [{ instruction: "Mix" }],
              ingredients: [
                ingredientRef(flourCode, {
                  amounts: [{ value: 1, unit: "lb" }],
                }),
              ],
            },
          ],
        }),
        ctx.actor,
      );
      // Persist totals via the real costing engine (no fdc_id, so no USDA gap —
      // `complete: true`, costTotal exactly $4, caloriesTotal 0 for lack of
      // nutrition data).
      await createTestTRPCContext(ctx.db, {
        auth: { userId: ctx.actor.userId },
      }).services.recipeCosting.recompute([recipe.entityId]);

      const planned = await createMeal(
        ctx.db,
        {
          date: "2026-07-01",
          recipes: [{ recipeId: recipe.id, scale: 1 }],
        },
        ctx.actor,
      );
      expect(planned.recipes).toHaveLength(1);
      expect(planned.totals).toEqual(
        expect.objectContaining({
          costTotal: 4,
          caloriesTotal: 0,
          pending: false,
        }),
      );

      const [linkBefore] = await getDb(ctx.db)
        .select({ deletedAt: mealRecipe.deletedAt })
        .from(mealRecipe)
        .where(eq(mealRecipe.mealId, planned.entityId));
      expect(linkBefore?.deletedAt).toBeNull();

      await deleteRecipes(ctx.db, [recipe.entityId], ctx.actor);

      // 1. The MealRecipe row itself is soft-deleted, not left dangling.
      const [linkAfter] = await getDb(ctx.db)
        .select({ deletedAt: mealRecipe.deletedAt })
        .from(mealRecipe)
        .where(eq(mealRecipe.mealId, planned.entityId));
      expect(linkAfter?.deletedAt).not.toBeNull();

      // 2. Reading the meal no longer lists the deleted recipe.
      const after = await getMealByID(ctx.db, planned.entityId);
      expect(after?.recipes).toHaveLength(0);

      // 3. Its cost/calorie contribution is dropped from the rollup entirely
      // (not just hidden) — an empty recipe list means nothing to sum and
      // nothing pending.
      expect(after?.totals).toEqual(
        expect.objectContaining({
          costTotal: 0,
          caloriesTotal: 0,
          pending: false,
        }),
      );

      // The cascade is also visible in the delete's audit trail.
      const [entry] = await getDb(ctx.db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityId, recipe.entityId),
            eq(auditLog.action, "delete"),
          ),
        )
        .limit(1);
      expect(entry?.changes?.cascadedMealRecipes).toEqual({ from: 1, to: 0 });
    });
  });

  describe("upsert variants", () => {
    it("upsertNotionRecipe re-imports a renamed page in place, updating the title", async () => {
      const pageId = "notion-page-123";
      const first = await upsertNotionRecipe(
        makeRecipeInput({
          name: "Original Title",
          sections: [
            { instructions: [{ instruction: "Step" }], ingredients: [] },
          ],
        }),
        pageId,
        ctx.db,
        ctx.actor,
      );
      // A renamed Notion page is still the same page id → updates in place, no dup.
      const renamed = await upsertNotionRecipe(
        makeRecipeInput({
          name: "Renamed Title",
          sections: [
            { instructions: [{ instruction: "Step" }], ingredients: [] },
          ],
        }),
        pageId,
        ctx.db,
        ctx.actor,
      );

      expect(renamed.id).toBe(first.id);
      const rows = await getDb(ctx.db)
        .select({ id: recipe.id })
        .from(recipe)
        .where(and(eq(recipe.SourceData, pageId), notDeleted(recipe)));
      expect(rows).toHaveLength(1);
      // Page id is the identity key; re-import reflects the source, so the renamed
      // page's new title is written through (Notion names are exempt from
      // Recipe_name_key, so the rename can't collide).
      const full = await getRecipeByID(ctx.db, renamed.id);
      expect(full?.name).toBe("Renamed Title");
    });

    it("upsertNotionRecipe re-import syncs changed tags and servings", async () => {
      const pageId = "notion-page-tags";
      const first = await upsertNotionRecipe(
        {
          ...makeRecipeInput({ name: "Tagged" }),
          servings: 4,
          tags: ["dinner"],
        },
        pageId,
        ctx.db,
        ctx.actor,
      );
      // Notion supplies tags from page columns, so a re-import reflects them
      // (including changes) — unlike a manual edit, which doesn't survive.
      const reimport = await upsertNotionRecipe(
        {
          ...makeRecipeInput({ name: "Tagged" }),
          servings: 8,
          tags: ["lunch", "quick"],
        },
        pageId,
        ctx.db,
        ctx.actor,
      );
      expect(reimport.id).toBe(first.id);

      const full = await getRecipeByID(ctx.db, reimport.id);
      expect(full?.servings).toBe(8);
      expect(full?.tags).toEqual(["lunch", "quick"]);
    });

    it("upsertRecipe (web) does not collide with a same-named cookbook recipe", async () => {
      const { entityId: cookbookId } = await upsertCookbook(
        ctx.db,
        { name: "Book A", rawJson: [], sourceLabel: "Book A" },
        ctx.actor,
      );
      const book = await upsertCookbookRecipe(
        makeRecipeInput({
          name: "Shared Name",
          sections: [{ instructions: [{ instruction: "B" }], ingredients: [] }],
        }),
        { id: cookbookId, name: "Book A" },
        ctx.db,
        ctx.actor,
      );
      const web = await upsertRecipe(
        makeRecipeInput({
          name: "Shared Name",
          url: "https://example.com/r",
          sections: [{ instructions: [{ instruction: "W" }], ingredients: [] }],
        }),
        ctx.db,
        ctx.actor,
      );

      // The web upsert matches on `SourceType IS DISTINCT FROM 'Book'` + name, so a
      // Book recipe is exempted — scraping a same-named site won't clobber it.
      expect(web.id).not.toBe(book.id);
    });
  });

  describe("updateRecipe", () => {
    it("replaces a section's ingredient rows", async () => {
      const sugar = await createIngredient(
        ctx.db,
        { name: "Sugar", aliases: [] },
        ctx.actor,
      );
      const recipe = await recipeWith("Editable", flourCode);

      await updateRecipe(
        ctx.db,
        recipe.entityId,
        {
          sections: [
            {
              name: "Main",
              instructions: [{ instruction: "Mix" }],
              ingredients: [
                ingredientRef(sugar.id, {
                  amounts: [{ value: 1, unit: "cup" }],
                }),
              ],
            },
          ],
        },
        ctx.actor,
      );

      const full = await getRecipeByID(ctx.db, recipe.entityId);
      const ingredients = full!.sections.flatMap((s) => s.ingredients);
      const names = ingredients.flatMap((i) =>
        i.type === "ingredient" ? [i.ingredient.name] : [],
      );
      expect(names).toContain("Sugar");
      expect(names).not.toContain("Flour");
    });

    it("writes an audit diff when the name changes", async () => {
      const recipe = await recipeWith("Old Name", flourCode);
      await updateRecipe(
        ctx.db,
        recipe.entityId,
        { name: "New Name" },
        ctx.actor,
      );

      const [entry] = await getDb(ctx.db)
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entityId, recipe.entityId),
            eq(auditLog.action, "update"),
          ),
        )
        .orderBy(desc(auditLog.createdAt))
        .limit(1);

      expect(entry?.changes?.name).toEqual({
        from: "Old Name",
        to: "New Name",
      });
    });
  });

  describe("tagsPresenceFilter", () => {
    /** Both shapes of "untagged" plus one tagged recipe. */
    const seedTagMix = async () => {
      await createRecipe(
        ctx.db,
        makeRecipeInput({ name: "never tagged", tags: null }),
        ctx.actor,
      );
      await createRecipe(
        ctx.db,
        makeRecipeInput({ name: "tags cleared", tags: [] }),
        ctx.actor,
      );
      await createRecipe(
        ctx.db,
        makeRecipeInput({ name: "tagged", tags: ["quick"] }),
        ctx.actor,
      );
    };

    const listNames = async (filters: RecipeFilters) =>
      (
        await recipeList(
          ctx.db,
          filters,
          [{ orderBy: "name", direction: "asc" }],
          { pageIndex: 0, pageSize: 50 },
        )
      ).data.map((r) => r.name);

    // The `cardinality` half of TAGS_ARE_EMPTY exists for "tags cleared":
    // removing a recipe's last tag writes `{}`, not NULL, so an IS NULL-only
    // predicate would hide it from the very view meant to find it.
    it("'none' matches a null tags column AND an empty array", async () => {
      await seedTagMix();
      const names = await listNames({ tagsPresenceFilter: "none" });
      expect(names).toEqual(["never tagged", "tags cleared"]);
    });

    it("'has' is the exact complement — only genuinely tagged recipes", async () => {
      await seedTagMix();
      expect(await listNames({ tagsPresenceFilter: "has" })).toEqual([
        "tagged",
      ]);
    });

    it("ORs with tagFilters rather than narrowing them", async () => {
      await seedTagMix();
      const names = await listNames({
        tagFilters: ["quick"],
        tagsPresenceFilter: "none",
      });
      expect(names).toEqual(["never tagged", "tagged", "tags cleared"]);
    });

    describe("mealPresenceFilter", () => {
      it("partitions planned recipes from never-planned ones", async () => {
        const planned = await createRecipe(
          ctx.db,
          makeRecipeInput({ name: "planned recipe" }),
          ctx.actor,
        );
        await createRecipe(
          ctx.db,
          makeRecipeInput({ name: "unplanned recipe" }),
          ctx.actor,
        );
        await createMeal(
          ctx.db,
          { date: "2026-07-01", recipes: [{ recipeId: planned.id, scale: 1 }] },
          ctx.actor,
        );

        expect(await listNames({ mealPresenceFilter: "has" })).toEqual([
          "planned recipe",
        ]);
        expect(await listNames({ mealPresenceFilter: "none" })).toEqual([
          "unplanned recipe",
        ]);
      });

      /**
       * The subquery inner-joins Meal with notDeleted: a live MealRecipe row
       * under a soft-deleted Meal is not a plan. A one-table subquery over
       * MealRecipe alone would still count this recipe as planned.
       */
      it("a soft-deleted meal doesn't count as a plan", async () => {
        const stranded = await createRecipe(
          ctx.db,
          makeRecipeInput({ name: "stranded recipe" }),
          ctx.actor,
        );
        const doomed = await createMeal(
          ctx.db,
          {
            date: "2026-07-02",
            recipes: [{ recipeId: stranded.id, scale: 1 }],
          },
          ctx.actor,
        );
        await deleteMeals(ctx.db, [doomed.entityId], ctx.actor);

        expect(await listNames({ mealPresenceFilter: "has" })).toEqual([]);
        expect(await listNames({ mealPresenceFilter: "none" })).toEqual([
          "stranded recipe",
        ]);
      });
    });
  });
});

import type { IngredientShortcode } from "@cubby/schemas/identifiers";
