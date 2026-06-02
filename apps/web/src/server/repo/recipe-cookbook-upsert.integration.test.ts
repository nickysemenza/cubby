import type { CompactRecipe } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import {
  unsafeIngredientId,
  unsafeRecipeId,
  unsafeUserId,
} from "@cubby/schemas/identifiers";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { and, eq } from "drizzle-orm";
import { buildTestDB } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "~/server/db";
import { recipe } from "~/server/db/schema";
import { getDb } from "./database-helpers";
import { createIngredient } from "./ingredient";
import {
  getCookbookRecipeTitles,
  getRecipeByID,
  insertCookbookRecipe,
  upsertCookbookRecipe,
  upsertRecipe,
} from "./recipe";

const TEST_ACTOR: ActorContext = {
  userId: unsafeUserId("test-user-id"),
  source: "epub_import",
};

describe("upsertCookbookRecipe", () => {
  let db: Database;
  let teardown: () => Promise<void>;
  let ingredientId: string;

  beforeEach(async () => {
    ({ db, teardown } = await buildTestDB());
    const ing = await createIngredient(
      db,
      { name: "Flour", aliases: [] },
      TEST_ACTOR,
    );
    ingredientId = ing.id;
    return teardown;
  });

  const recipeInput = (
    name: string,
    instruction = "Mix",
  ): RecipeCreateInput => ({
    name,
    meta: { url: null },
    sections: [
      {
        instructions: [{ instruction }],
        ingredients: [
          {
            type: "ingredient" as const,
            ingredientId: unsafeIngredientId(ingredientId),
            recipeId: null,
            amounts: [{ value: 2, unit: "cups" }],
          },
        ],
      },
    ],
  });

  it("creates a recipe stamped with Book provenance", async () => {
    const { id } = await upsertCookbookRecipe(
      recipeInput("Pancakes"),
      "Book A",
      db,
      TEST_ACTOR,
    );

    const found = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.id, id),
    });
    expect(found!.SourceType).toBe("Book");
    expect(found!.SourceData).toBe("Book A");
  });

  it("re-importing the same (book, title) updates in place, no duplicate", async () => {
    const first = await upsertCookbookRecipe(
      recipeInput("Pancakes", "Mix gently"),
      "Book A",
      db,
      TEST_ACTOR,
    );
    const second = await upsertCookbookRecipe(
      recipeInput("Pancakes", "Mix vigorously"),
      "Book A",
      db,
      TEST_ACTOR,
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
      "Book A",
      db,
      TEST_ACTOR,
    );
    const b = await upsertCookbookRecipe(
      recipeInput("Pancakes"),
      "Book B",
      db,
      TEST_ACTOR,
    );

    expect(b.id).not.toBe(a.id);

    const all = await getDb(db).query.recipe.findMany({
      where: eq(recipe.name, "Pancakes"),
    });
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.SourceData).sort()).toEqual(["Book A", "Book B"]);
  });

  it("does not collide with a website-scraped recipe of the same name", async () => {
    const website = await upsertRecipe(
      {
        name: "Pancakes",
        meta: { url: "https://example.com/pancakes" },
        sections: [{ instructions: [{ instruction: "Web" }], ingredients: [] }],
      },
      db,
      TEST_ACTOR,
    );
    const book = await upsertCookbookRecipe(
      recipeInput("Pancakes"),
      "Book A",
      db,
      TEST_ACTOR,
    );

    expect(book.id).not.toBe(website.id);

    // Website recipe untouched.
    const web = await getDb(db).query.recipe.findFirst({
      where: and(eq(recipe.id, website.id)),
    });
    expect(web!.SourceType).toBe("Website");
    expect(web!.SourceData).toBe("https://example.com/pancakes");
  });

  it("persists yield and servings", async () => {
    const { id } = await upsertCookbookRecipe(
      {
        ...recipeInput("Pancakes"),
        yield: { value: 12, unit: "pancakes" },
        servings: 4,
      },
      "Book A",
      db,
      TEST_ACTOR,
    );

    const found = await getDb(db).query.recipe.findFirst({
      where: eq(recipe.id, id),
    });
    expect(found!.yield).toEqual({ value: 12, unit: "pancakes" });
    expect(found!.servings).toBe(4);
  });

  it("getCookbookRecipeTitles returns only this book's non-deleted titles", async () => {
    await upsertCookbookRecipe(
      recipeInput("Pancakes"),
      "Book A",
      db,
      TEST_ACTOR,
    );
    await upsertCookbookRecipe(
      recipeInput("Waffles"),
      "Book A",
      db,
      TEST_ACTOR,
    );
    await upsertCookbookRecipe(recipeInput("Crepes"), "Book B", db, TEST_ACTOR);

    const titles = await getCookbookRecipeTitles(db, "Book A");
    expect(titles.sort()).toEqual(["Pancakes", "Waffles"]);
  });

  // A raw cookbook CompactRecipe (ingredient lines are strings, parsed server-side).
  const compact = (name: string, ingredients: string[]): CompactRecipe => ({
    name,
    sections: [{ name: null, ingredients, instructions: [] }],
  });

  const piecrustRef = {
    title: "The Only Piecrust",
    line: "1 recipe The Only Piecrust",
    confidence: "title_match" as const,
  };

  it("links a cross-recipe reference as a sub-recipe (two-pass)", async () => {
    // Pass 1: both recipes imported flat (no references resolved yet).
    const piecrust = await insertCookbookRecipe(
      compact("The Only Piecrust", ["2 cups flour"]),
      "Book A",
      [],
      db,
      TEST_ACTOR,
    );
    await insertCookbookRecipe(
      compact("Apple Galette", ["1 recipe The Only Piecrust", "3 apples"]),
      "Book A",
      [],
      db,
      TEST_ACTOR,
    );

    // Pass 2: re-import the galette with its reference → links to the piecrust.
    const galette = await insertCookbookRecipe(
      compact("Apple Galette", ["1 recipe The Only Piecrust", "3 apples"]),
      "Book A",
      [piecrustRef],
      db,
      TEST_ACTOR,
    );

    const full = await getRecipeByID(db, unsafeRecipeId(galette.id));
    const ingredients = full!.sections.flatMap((s) => s.ingredients);
    const linked = ingredients.find((ing) => ing.type === "recipe");
    expect(linked).toBeDefined();
    expect(linked?.recipe?.id).toBe(piecrust.id);
    // The non-reference line ("3 apples") stays a flat ingredient.
    expect(ingredients.some((ing) => ing.type === "ingredient")).toBe(true);
  });

  it("leaves a reference whose target isn't imported as a flat ingredient", async () => {
    const galette = await insertCookbookRecipe(
      compact("Galette", ["1 recipe Missing Dough"]),
      "Book A",
      [
        {
          title: "Missing Dough",
          line: "1 recipe Missing Dough",
          confidence: "title_match",
        },
      ],
      db,
      TEST_ACTOR,
    );

    const full = await getRecipeByID(db, unsafeRecipeId(galette.id));
    const ingredients = full!.sections.flatMap((s) => s.ingredients);
    expect(ingredients.every((ing) => ing.type === "ingredient")).toBe(true);
  });
});
