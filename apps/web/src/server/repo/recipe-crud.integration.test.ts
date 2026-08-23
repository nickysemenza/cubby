import { and, desc, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestTRPCContext } from "~/server/api/trpc";
import {
  auditLog,
  ingredient,
  mealRecipe,
  recipe,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { upsertCookbook } from "./cookbook";
import { getDb, insertAndReturn, notDeleted } from "./database-helpers";
import { deleteMeals, getMealByID } from "./meal";
import {
  deleteRecipes,
  duplicateRecipe,
  getRecipeByID,
  getRecipeCoverImageUrlsByShortcodes,
  recipeList,
  updateRecipe,
  upsertCookbookRecipe,
  upsertNotionRecipe,
  upsertRecipe,
} from "./recipe";
import type { RecipeFilters } from "./recipe/internal-types";
import {
  createImageFixture,
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

  it("selects the first live displayable recipe cover", async () => {
    const illustrated = await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Selective cover" }),
      ctx.actor,
    );
    const document = await createImageFixture(ctx.db, "recipe-manual", {
      filename: "recipe-manual.pdf",
      contentType: "application/pdf",
    });
    const deleted = await createImageFixture(ctx.db, "deleted-cover", {
      deletedAt: new Date(),
    });
    const cover = await createImageFixture(ctx.db, "live-cover");
    await insertAndReturn(ctx.db, recipeImage, {
      recipeId: illustrated.entityId,
      imageId: document.id,
      sortOrder: -3,
    });
    await insertAndReturn(ctx.db, recipeImage, {
      recipeId: illustrated.entityId,
      imageId: deleted.id,
      sortOrder: -2,
    });
    await insertAndReturn(ctx.db, recipeImage, {
      recipeId: illustrated.entityId,
      imageId: cover.id,
      sortOrder: -1,
    });

    const covers = await getRecipeCoverImageUrlsByShortcodes(ctx.db, [
      illustrated.id,
    ]);
    expect(covers.get(illustrated.id)).toBe(cover.url);
  });

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

  describe("duplicateRecipe", () => {
    it("clones the graph into a fresh '<name> (copy)' recipe without touching the source", async () => {
      const sugar = await createIngredient(
        ctx.db,
        { name: "Sugar", aliases: [] },
        ctx.actor,
      );
      const subRecipe = await createRecipe(
        ctx.db,
        makeRecipeInput({ name: "Sauce" }),
        ctx.actor,
      );
      const source = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Original",
          tags: ["dinner"],
          sections: [
            {
              name: "Main",
              instructions: [{ instruction: "Mix" }],
              ingredients: [
                ingredientRef(sugar.id, {
                  amounts: [{ value: 1, unit: "cup" }],
                }),
                {
                  type: "recipe",
                  recipeId: subRecipe.id,
                  ingredientId: null,
                  amounts: [{ value: 1, unit: "each" }],
                },
              ],
            },
          ],
        }),
        ctx.actor,
      );

      const duplicated = await duplicateRecipe(
        ctx.db,
        source.entityId,
        ctx.actor,
      );

      expect(duplicated.id).not.toBe(source.id);
      expect(duplicated.name).toBe("Original (copy)");
      expect(duplicated.tags).toEqual(["dinner"]);
      expect(duplicated.sections).toHaveLength(1);
      const section = duplicated.sections[0]!;
      // Fresh section id — dropped, not copied, from the source.
      expect(section.id).not.toBe(source.sections[0]!.id);
      expect(section.instructions).toEqual([{ instruction: "Mix" }]);
      const ingredientNames = section.ingredients.flatMap((i) =>
        i.type === "ingredient" ? [i.ingredient.name] : [],
      );
      expect(ingredientNames).toEqual(["Sugar"]);
      // The sub-recipe (type: "recipe") ingredient branch is also reshaped
      // correctly — it's the less obvious half of the discriminated union.
      const subRecipeLinks = section.ingredients.flatMap((i) =>
        i.type === "recipe" ? [i.recipe.id] : [],
      );
      expect(subRecipeLinks).toEqual([subRecipe.id]);

      // The source recipe is untouched by the clone.
      const stillSource = await getRecipeByID(ctx.db, source.entityId);
      expect(stillSource?.name).toBe("Original");
    });

    it("copies image associations as new join rows pointing at the SAME Image row", async () => {
      const cover = await createImageFixture(ctx.db, "cover", {
        key: "test-recipes/cover.png",
        size: 10,
      });
      const source = await createRecipe(
        ctx.db,
        {
          ...makeRecipeInput({ name: "Illustrated" }),
          pendingImageIds: [unsafeImageShortcode(cover.shortcode)],
        },
        ctx.actor,
      );

      const duplicated = await duplicateRecipe(
        ctx.db,
        source.entityId,
        ctx.actor,
      );

      // No new Image row was minted — the duplicate's cover is the SAME row.
      expect(duplicated.images).toHaveLength(1);
      expect(duplicated.images[0]!.id).toBe(
        unsafeImageShortcode(cover.shortcode),
      );

      // Both recipes now carry their own live RecipeImage join row for it.
      const joinRows = await getDb(ctx.db)
        .select({ recipeId: recipeImage.recipeId })
        .from(recipeImage)
        .where(and(eq(recipeImage.imageId, cover.id), notDeleted(recipeImage)));
      expect(joinRows).toHaveLength(2);
      expect(joinRows.map((r) => r.recipeId)).toContain(source.entityId);
    });

    // Regression guard: a hardcoded `webProvenance(meta.url)` fallback silently
    // coerced every duplicate to SourceType='Website', dropping `cookbookId` —
    // meta.url is null for anything but a Website recipe. Book recipes are 94%
    // of live recipes on production, so this is the case that matters most.
    it("carries Book provenance — cookbookId, SourceType, SourceData — through to the duplicate", async () => {
      const {
        entityId: cookbookId,
        output: { id: cookbookShortcode },
      } = await upsertCookbook(
        ctx.db,
        {
          name: "Duplicate Test Book",
          rawJson: [],
          sourceLabel: "Duplicate Test Book",
        },
        ctx.actor,
      );
      const source = await upsertCookbookRecipe(
        makeRecipeInput({ name: "Book Original" }),
        { id: cookbookId, name: "Duplicate Test Book" },
        ctx.db,
        ctx.actor,
      );

      const duplicated = await duplicateRecipe(ctx.db, source.id, ctx.actor);

      expect(duplicated.name).toBe("Book Original (copy)");
      expect(duplicated.source).toEqual({
        type: "book",
        book: "Duplicate Test Book",
        cookbookId: cookbookShortcode,
      });

      // The raw columns, not just the reshaped `source` union — this is what
      // the `webProvenance` fallback silently dropped.
      const [row] = await getDb(ctx.db)
        .select({
          SourceType: recipe.SourceType,
          SourceData: recipe.SourceData,
          cookbookId: recipe.cookbookId,
        })
        .from(recipe)
        .where(eq(recipe.shortcode, duplicated.id));
      expect(row).toEqual({
        SourceType: "Book",
        SourceData: "Duplicate Test Book",
        cookbookId,
      });

      // `Recipe_book_title_key` is unique on (name, SourceData) where
      // SourceType='Book' — the " (copy)" suffix keeps the duplicate's name
      // distinct from the source's, so this doesn't collide even though
      // SourceData (the book name) is identical.
    });

    // Recipe_notion_page_key is unique on SourceData ALONE (no name component)
    // wherever SourceType='Notion' — a page id must resolve to exactly one live
    // recipe. Carrying the source's page id through to the duplicate would
    // violate that index (both rows are live, and the name differs, so nothing
    // else stops the collision the way Recipe_book_title_key's name column
    // does for Book). duplicateRecipe deliberately drops a Notion duplicate to
    // "Other" instead.
    it("drops a Notion duplicate to 'Other' rather than collide on Recipe_notion_page_key", async () => {
      const pageId = "notion-page-duplicate-test";
      const source = await upsertNotionRecipe(
        makeRecipeInput({ name: "Notion Original" }),
        pageId,
        ctx.db,
        ctx.actor,
      );

      const duplicated = await duplicateRecipe(ctx.db, source.id, ctx.actor);

      expect(duplicated.source).toEqual({ type: "other" });

      const [row] = await getDb(ctx.db)
        .select({
          SourceType: recipe.SourceType,
          SourceData: recipe.SourceData,
        })
        .from(recipe)
        .where(eq(recipe.shortcode, duplicated.id));
      expect(row).toEqual({ SourceType: "Other", SourceData: null });

      // The source recipe still owns the page id — untouched by the duplicate,
      // and still the sole target `upsertNotionRecipe` would re-import into.
      const [sourceRow] = await getDb(ctx.db)
        .select({
          SourceType: recipe.SourceType,
          SourceData: recipe.SourceData,
        })
        .from(recipe)
        .where(eq(recipe.id, source.id));
      expect(sourceRow).toEqual({ SourceType: "Notion", SourceData: pageId });
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

      // …and each can be referenced as a sub-recipe. Both link rows are named
      // `Recipe: Shared Name`, so while `Ingredient_name_key` spanned the
      // recipe-linked rows the second insert conflicted on an index its `where`
      // (recipeId) couldn't see: no row inserted, no winner to re-find, and the
      // failure reported itself as three shortcode collisions.
      const parent = await createRecipe(
        ctx.db,
        makeRecipeInput({
          name: "Uses Both",
          sections: [
            {
              instructions: [{ instruction: "Combine" }],
              ingredients: [
                {
                  type: "recipe",
                  recipeId: unsafeRecipeShortcode(book.shortcode),
                  ingredientId: null,
                  amounts: [{ value: 1, unit: "each" }],
                },
                {
                  type: "recipe",
                  recipeId: unsafeRecipeShortcode(web.shortcode),
                  ingredientId: null,
                  amounts: [{ value: 1, unit: "each" }],
                },
              ],
            },
          ],
        }),
        ctx.actor,
      );

      const links = (await getRecipeByID(ctx.db, parent.entityId))!.sections
        .flatMap((s) => s.ingredients)
        .flatMap((i) => (i.type === "recipe" ? [i.recipe] : []));
      expect(links.map((r) => r.id).sort()).toEqual(
        [book.shortcode, web.shortcode].sort(),
      );
    });

    it("does not resurrect a soft-deleted sub-recipe link", async () => {
      const child = await createRecipe(
        ctx.db,
        makeRecipeInput({ name: "Sauce" }),
        ctx.actor,
      );
      const subRecipeSection = [
        {
          instructions: [{ instruction: "Add sauce" }],
          ingredients: [
            {
              type: "recipe" as const,
              recipeId: child.id,
              ingredientId: null,
              amounts: [{ value: 1, unit: "each" }],
            },
          ],
        },
      ];
      const parent = await createRecipe(
        ctx.db,
        makeRecipeInput({ name: "Bowl", sections: subRecipeSection }),
        ctx.actor,
      );

      // Retire the link row. `Ingredient_recipeId_key` is partial on
      // `deletedAt IS NULL`, so a fresh link for the same recipe is legal — but a
      // match predicate that omitted `notDeleted` would find this dead row first
      // and re-point the live section at it.
      const [dead] = await getDb(ctx.db)
        .update(ingredient)
        .set({ deletedAt: new Date() })
        .where(eq(ingredient.recipeId, child.entityId))
        .returning();

      await updateRecipe(
        ctx.db,
        parent.entityId,
        { sections: subRecipeSection },
        ctx.actor,
      );

      const relinked = (await getRecipeByID(ctx.db, parent.entityId))!.sections
        .flatMap((s) => s.ingredients)
        .find((i) => i.type === "recipe");
      expect(relinked?.type).toBe("recipe");

      const live = await getDb(ctx.db).query.ingredient.findFirst({
        where: and(
          eq(ingredient.recipeId, child.entityId),
          notDeleted(ingredient),
        ),
      });
      expect(live).toBeDefined();
      expect(live!.id).not.toBe(dead!.id);
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

import {
  type IngredientShortcode,
  unsafeImageShortcode,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
