import type { ActorContext } from "@cubby/schemas/context";
import type { RecipeId } from "@cubby/schemas/identifiers";
import { and, desc, eq } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
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
  updateRecipe,
  upsertCookbookRecipe,
  upsertNotionRecipe,
  upsertRecipe,
} from "./recipe";
import { ingredientRef, makeRecipeInput } from "./repo.fixtures";

// Direct repo-layer tests for recipe/crud.ts: the soft-delete cascade + audit
// trail, the keyed upsert variants, and updateRecipe's section replacement +
// audit diff. (Cookbook upsert idempotency / two-book distinctness already live
// in recipe-cookbook-upsert.integration.test.ts; this file covers the rest.)

describe("recipe crud repo", () => {
  let db: Database;
  let actor: ActorContext;
  let teardown: () => Promise<void>;
  let flourId: string;
  beforeEach(async () => {
    ({ db, actor, teardown } = await buildTestDB());
    const flour = await createIngredient(
      db,
      { name: "Flour", aliases: [] },
      actor,
    );
    flourId = flour.id;
    return teardown;
  });

  const recipeWith = (name: string, ingredientId: string) =>
    createRecipe(
      db,
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
      actor,
    );

  describe("deleteRecipes", () => {
    it("soft-deletes the recipe and cascades to its sections and ingredients", async () => {
      const recipe = await recipeWith("Doomed", flourId);
      const sectionId = recipe.sections[0]!.id;

      await deleteRecipes(db, [recipe.id as RecipeId], actor);

      // Excluded from reads.
      expect(await getRecipeByID(db, recipe.id as RecipeId)).toBeNull();

      // Section + ingredient rows still exist but are soft-deleted (excluded by notDeleted).
      const liveSections = await getDb(db)
        .select({ id: recipeSection.id })
        .from(recipeSection)
        .where(
          and(eq(recipeSection.recipeId, recipe.id), notDeleted(recipeSection)),
        );
      expect(liveSections).toHaveLength(0);

      const liveIngredients = await getDb(db)
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
      await deleteRecipes(db, [recipe.id as RecipeId], actor);

      const [entry] = await getDb(db)
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
        db,
        actor,
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
        db,
        actor,
      );

      expect(renamed.id).toBe(first.id);
      const rows = await getDb(db)
        .select({ id: recipe.id })
        .from(recipe)
        .where(and(eq(recipe.SourceData, pageId), notDeleted(recipe)));
      expect(rows).toHaveLength(1);
      // Page id is the identity key; re-import reflects the source, so the renamed
      // page's new title is written through (Notion names are exempt from
      // Recipe_name_key, so the rename can't collide).
      const full = await getRecipeByID(db, renamed.id);
      expect(full?.name).toBe("Renamed Title");
    });

    it("upsertRecipe (web) does not collide with a same-named cookbook recipe", async () => {
      const { id: cookbookId } = await upsertCookbook(
        db,
        { name: "Book A", rawJson: [], sourceLabel: "Book A" },
        actor,
      );
      const book = await upsertCookbookRecipe(
        makeRecipeInput({
          name: "Shared Name",
          sections: [{ instructions: [{ instruction: "B" }], ingredients: [] }],
        }),
        { id: cookbookId, name: "Book A" },
        db,
        actor,
      );
      const web = await upsertRecipe(
        makeRecipeInput({
          name: "Shared Name",
          url: "https://example.com/r",
          sections: [{ instructions: [{ instruction: "W" }], ingredients: [] }],
        }),
        db,
        actor,
      );

      // The web upsert matches on `SourceType IS DISTINCT FROM 'Book'` + name, so a
      // Book recipe is exempted — scraping a same-named site won't clobber it.
      expect(web.id).not.toBe(book.id);
    });
  });

  describe("updateRecipe", () => {
    it("replaces a section's ingredient rows", async () => {
      const sugar = await createIngredient(
        db,
        { name: "Sugar", aliases: [] },
        actor,
      );
      const recipe = await recipeWith("Editable", flourId);

      await updateRecipe(
        db,
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
        actor,
      );

      const full = await getRecipeByID(db, recipe.id as RecipeId);
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
        db,
        recipe.id as RecipeId,
        { name: "New Name" },
        actor,
      );

      const [entry] = await getDb(db)
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
});
