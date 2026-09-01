import type { ActorContext } from "@cubby/schemas/context";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import { recipe } from "~/server/db/schema";

import { upsertCookbook } from "./cookbook";
import { getDb } from "./database-helpers";
import {
  type CookbookImportContext,
  upsertCookbookRecipeFromCookbook,
} from "./import-recipe-convert";
import { createIngredient } from "./ingredient";
import {
  type CookbookRef,
  getRecipeByID,
  upsertCookbookRecipe,
} from "./recipe";
import {
  cookbookRecipe,
  ingredientRef,
  makeRecipeInput,
} from "./repo.fixtures";

// This suite imports from cookbooks — stamp the actor as an epub import.
describe("upsertCookbookRecipe", () => {
  const ctx = withTestDb("epub_import");
  let db: Database;
  let actor: ActorContext;
  let ingredientId: string;
  let bookA: CookbookRef;
  let bookB: CookbookRef;

  // Create a cookbook row up-front and return the ref recipes link to. rawJson
  // is empty here (reprocess isn't exercised in this suite).
  const mkCookbook = async (name: string): Promise<CookbookRef> => {
    const { entityId: id } = await upsertCookbook(
      db,
      { name, rawJson: [], sourceLabel: name },
      actor,
    );
    return { id, name };
  };

  beforeEach(async () => {
    db = ctx.db;
    actor = ctx.actor;

    const ing = await createIngredient(
      db,
      { name: "Flour", aliases: [] },
      actor,
    );
    ingredientId = ing.id;
    bookA = await mkCookbook("Book A");
    bookB = await mkCookbook("Book B");
  });

  const recipeInput = (name: string, instruction = "Mix"): RecipeCreateInput =>
    makeRecipeInput({
      name,
      sections: [
        {
          instructions: [{ instruction }],
          ingredients: [
            ingredientRef(ingredientId, {
              amounts: [{ value: 2, unit: "cups" }],
            }),
          ],
        },
      ],
    });

  it("re-importing the same (book, title) updates in place, no duplicate", async () => {
    const first = await upsertCookbookRecipe(
      recipeInput("Pancakes", "Mix gently"),
      bookA,
      db,
      actor,
    );
    const second = await upsertCookbookRecipe(
      recipeInput("Pancakes", "Mix vigorously"),
      bookA,
      db,
      actor,
    );

    expect(second.id).toBe(first.id);

    const all = await getDb(db).query.recipe.findMany({
      where: eq(recipe.name, "Pancakes"),
    });
    expect(all).toHaveLength(1);

    const found = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.id, first.id),
      with: { sections: true },
    });
    expect(found!.sections[0]!.instructions).toEqual([
      { text: "Mix vigorously" },
    ]);
  });

  it("keeps the same title from two different books distinct", async () => {
    const a = await upsertCookbookRecipe(
      recipeInput("Pancakes"),
      bookA,
      db,
      actor,
    );
    const b = await upsertCookbookRecipe(
      recipeInput("Pancakes"),
      bookB,
      db,
      actor,
    );

    expect(b.id).not.toBe(a.id);

    const all = await getDb(db).query.recipe.findMany({
      where: eq(recipe.name, "Pancakes"),
    });
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.SourceData).sort()).toEqual(["Book A", "Book B"]);
  });

  const piecrustRef = {
    title: "The Only Piecrust",
    line: "1 recipe The Only Piecrust",
    confidence: "title_match" as const,
  };

  it("links a cross-recipe reference as a sub-recipe (two-pass)", async () => {
    // Pass 1: both recipes imported flat (no references resolved yet).
    const piecrust = await upsertCookbookRecipeFromCookbook(
      cookbookRecipe("The Only Piecrust", ["2 cups flour"]),
      bookA,
      db,
      actor,
    );
    await upsertCookbookRecipeFromCookbook(
      cookbookRecipe("Apple Galette", [
        "1 recipe The Only Piecrust",
        "3 apples",
      ]),
      bookA,
      db,
      actor,
    );

    // Pass 2: re-import the galette with its reference → links to the piecrust.
    const galette = await upsertCookbookRecipeFromCookbook(
      cookbookRecipe(
        "Apple Galette",
        ["1 recipe The Only Piecrust", "3 apples"],
        { references: [piecrustRef] },
      ),
      bookA,
      db,
      actor,
    );

    const full = await getRecipeByID(db, galette.id);
    const ingredients = full!.sections.flatMap((s) => s.ingredients);
    const linked = ingredients.find((ing) => ing.type === "recipe");
    expect(linked).toBeDefined();
    expect(linked?.recipe?.id).toBe(piecrust.shortcode);
    // The non-reference line ("3 apples") stays a flat ingredient.
    expect(ingredients.some((ing) => ing.type === "ingredient")).toBe(true);
  });

  // A fresh per-import context, as the importCookbookStream / reprocess loops
  // build it for an empty/new book.
  const newImportCtx = (): CookbookImportContext => ({
    titleToId: new Map(),
    ingredientIdByName: new Map(),
  });

  it("links a forward reference in one pass via the import context (topo order)", async () => {
    const ctx = newImportCtx();
    // Topo order: the referenced sub-recipe commits first; the context's running
    // titleToId then lets its referrer link on the same pass (no re-import).
    const piecrust = await upsertCookbookRecipeFromCookbook(
      cookbookRecipe("The Only Piecrust", ["2 cups flour"]),
      bookA,
      db,
      actor,
      ctx,
    );
    const galette = await upsertCookbookRecipeFromCookbook(
      cookbookRecipe(
        "Apple Galette",
        ["1 recipe The Only Piecrust", "3 apples"],
        { references: [piecrustRef] },
      ),
      bookA,
      db,
      actor,
      ctx,
    );

    const full = await getRecipeByID(db, galette.id);
    const ingredients = full!.sections.flatMap((s) => s.ingredients);
    const linked = ingredients.find((ing) => ing.type === "recipe");
    expect(linked?.recipe?.id).toBe(piecrust.shortcode);
  });
});
