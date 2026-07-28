import type { RecipeId } from "@cubby/schemas/identifiers";
import { and, desc, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import {
  auditLog,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { upsertCookbook } from "./cookbook";
import { getDb, notDeleted } from "./database-helpers";
import { createIngredient } from "./ingredient";
import {
  createRecipe,
  deleteRecipes,
  getRecipeByID,
  recipeList,
  updateRecipe,
  upsertCookbookRecipe,
  upsertNotionRecipe,
  upsertRecipe,
} from "./recipe";
import type { RecipeFilters } from "./recipe/internal-types";
import { ingredientRef, makeRecipeInput } from "./repo.fixtures";

// Direct repo-layer tests for recipe/crud.ts: the soft-delete cascade + audit
// trail, the keyed upsert variants, and updateRecipe's section replacement +
// audit diff. (Cookbook upsert idempotency / two-book distinctness already live
// in recipe-cookbook-upsert.integration.test.ts; this file covers the rest.)

describe("recipe crud repo", () => {
  const ctx = withTestDb();
  let flourId: string;
  beforeEach(async () => {
    const flour = await createIngredient(
      ctx.db,
      { name: "Flour", aliases: [] },
      ctx.actor,
    );
    flourId = flour.id;
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
      const recipe = await recipeWith("Doomed", flourId);
      const sectionId = recipe.sections[0]!.id;

      await deleteRecipes(ctx.db, [recipe.id as RecipeId], ctx.actor);

      // Excluded from reads.
      expect(await getRecipeByID(ctx.db, recipe.id as RecipeId)).toBeNull();

      // Section + ingredient rows still exist but are soft-deleted (excluded by notDeleted).
      const liveSections = await getDb(ctx.db)
        .select({ id: recipeSection.id })
        .from(recipeSection)
        .where(
          and(eq(recipeSection.recipeId, recipe.id), notDeleted(recipeSection)),
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
      const recipe = await recipeWith("Audited", flourId);
      await deleteRecipes(ctx.db, [recipe.id as RecipeId], ctx.actor);

      const [entry] = await getDb(ctx.db)
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.entityId, recipe.id), eq(auditLog.action, "delete")),
        )
        .limit(1);

      expect(entry).toBeDefined();
      expect(entry?.changes?.cascadedSections).toEqual({ from: 1, to: 0 });
      expect(entry?.changes?.cascadedIngredients).toEqual({ from: 1, to: 0 });
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
      const { id: cookbookId } = await upsertCookbook(
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
      const recipe = await recipeWith("Editable", flourId);

      await updateRecipe(
        ctx.db,
        recipe.id as RecipeId,
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

      const full = await getRecipeByID(ctx.db, recipe.id as RecipeId);
      const ingredients = full!.sections.flatMap((s) => s.ingredients);
      const names = ingredients.flatMap((i) =>
        i.type === "ingredient" ? [i.ingredient.name] : [],
      );
      expect(names).toContain("Sugar");
      expect(names).not.toContain("Flour");
    });

    it("writes an audit diff when the name changes", async () => {
      const recipe = await recipeWith("Old Name", flourId);
      await updateRecipe(
        ctx.db,
        recipe.id as RecipeId,
        { name: "New Name" },
        ctx.actor,
      );

      const [entry] = await getDb(ctx.db)
        .select()
        .from(auditLog)
        .where(
          and(eq(auditLog.entityId, recipe.id), eq(auditLog.action, "update")),
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
  });
});
