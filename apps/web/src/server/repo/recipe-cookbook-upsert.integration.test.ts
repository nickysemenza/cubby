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
  ingredientRef,
  makeCookbookExtraction,
  makeCookbookImportContext,
  makeCookbookRecipe,
  makeRecipeInput,
} from "./repo.fixtures";

// This suite imports from cookbooks — stamp the actor as an epub import.
describe("upsertCookbookRecipe", () => {
  const ctx = withTestDb();
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
      { name, rawJson: makeCookbookExtraction(), sourceLabel: name },
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

  // The tree: a piecrust, and a galette whose first line references it by
  // item id (the crate resolved the reference; the importer only links).
  const piecrust = makeCookbookRecipe("The Only Piecrust", ["2 cups flour"], {
    id: "001.0001",
  });
  const galette = makeCookbookRecipe(
    "Apple Galette",
    [{ line: "1 recipe The Only Piecrust", ref: "001.0001" }, "3 apples"],
    { id: "001.0040" },
  );
  const tree = makeCookbookExtraction([piecrust, galette]);

  it("links a cross-recipe reference as a sub-recipe (two-pass)", async () => {
    // Pass 1: the galette first — its reference target is not imported yet,
    // so the line stays a plain ingredient.
    const first = await upsertCookbookRecipeFromCookbook(
      galette,
      "Recipes",
      bookA,
      db,
      actor,
      makeCookbookImportContext(tree),
    );
    const flat = await getRecipeByID(db, first.id);
    expect(
      flat!.sections
        .flatMap((s) => s.ingredients)
        .every((ing) => ing.type === "ingredient"),
    ).toBe(true);

    const crust = await upsertCookbookRecipeFromCookbook(
      piecrust,
      "Recipes",
      bookA,
      db,
      actor,
      makeCookbookImportContext(tree),
    );

    // Pass 2: re-import the galette with a context that knows the piecrust.
    const ctx = makeCookbookImportContext(tree);
    ctx.titleToId.set("the only piecrust", crust.id);
    const linked = await upsertCookbookRecipeFromCookbook(
      galette,
      "Recipes",
      bookA,
      db,
      actor,
      ctx,
    );

    const full = await getRecipeByID(db, linked.id);
    const ingredients = full!.sections.flatMap((s) => s.ingredients);
    const link = ingredients.find((ing) => ing.type === "recipe");
    expect(link).toBeDefined();
    expect(link?.recipe?.id).toBe(crust.shortcode);
    // The non-reference line ("3 apples") stays a flat ingredient.
    expect(ingredients.some((ing) => ing.type === "ingredient")).toBe(true);
    expect(full!.tags).toEqual(["Recipes"]);
  });

  it("links a forward reference in one pass via the import context (topo order)", async () => {
    const ctx: CookbookImportContext = makeCookbookImportContext(tree);
    // Topo order: the referenced sub-recipe commits first; the context's running
    // titleToId then lets its referrer link on the same pass (no re-import).
    const crust = await upsertCookbookRecipeFromCookbook(
      piecrust,
      "Recipes",
      bookA,
      db,
      actor,
      ctx,
    );
    const linked = await upsertCookbookRecipeFromCookbook(
      galette,
      "Recipes",
      bookA,
      db,
      actor,
      ctx,
    );

    const full = await getRecipeByID(db, linked.id);
    const ingredients = full!.sections.flatMap((s) => s.ingredients);
    const link = ingredients.find((ing) => ing.type === "recipe");
    expect(link?.recipe?.id).toBe(crust.shortcode);
  });
});
