import type { CompactRecipe, ParsedCompactRecipe } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import type { RecipeRef } from "@cubby/schemas/cookbook";
import { unsafeIngredientId } from "@cubby/schemas/identifiers";
import type { RecipeCreateInput } from "@cubby/schemas/recipe";
import { wasm } from "~/lib/wasm";
import type { Database } from "../db";
import { withTransaction } from "./database-helpers";
import { findOrCreateIngredient } from "./ingredient";
import {
  findOrCreateRecipeLinkIngredient,
  getCookbookRecipeIdsByTitle,
  upsertCookbookRecipe,
  upsertRecipe,
} from "./recipe";

// Convert ParsedCompactRecipe to RecipeCreateInput format
const convertParsedCompactToRecipeInput = async (
  recipe: ParsedCompactRecipe,
  db: Database,
): Promise<RecipeCreateInput> => {
  return await withTransaction(db, async (tx) => {
    return {
      name: recipe.name,
      meta: {
        url: recipe.meta?.url ?? null,
      },
      yield: recipe.recipe_yield ?? null,
      servings: recipe.servings ?? null,
      sections: await Promise.all(
        recipe.sections.map(async (section) => ({
          name: section.name ?? null,
          instructions: section.instructions.map((instruction) => ({
            instruction,
          })),
          ingredients: await Promise.all(
            section.ingredients.map(async (ingredient) => {
              const newIngredient = await findOrCreateIngredient(
                tx,
                ingredient.name,
              );
              return {
                type: "ingredient" as const,
                ingredientId: unsafeIngredientId(newIngredient.id),
                recipeId: null,
                amounts: ingredient.amounts,
              };
            }),
          ),
        })),
      ),
    };
  });
};

export const upsertRecipeFromCompact = async (
  recipe: ParsedCompactRecipe,
  db: Database,
  actor: ActorContext,
) => {
  // Convert compact recipe format to standard recipe input format
  const recipeInput = await convertParsedCompactToRecipeInput(recipe, db);

  // Use the centralized upsert logic
  return await upsertRecipe(recipeInput, db, actor);
};

/**
 * Cookbook conversion that links cross-recipe references. Unlike
 * {@link convertParsedCompactToRecipeInput}, it works from the *raw*
 * `CompactRecipe` (so it can match `RecipeRef.line` against the verbatim
 * ingredient line) and, when a line references another recipe in the same book
 * that already exists, emits a recipe-linked ingredient instead of a flat one.
 */
const convertCookbookCompactToRecipeInput = async (
  compact: CompactRecipe,
  book: string,
  references: RecipeRef[],
  db: Database,
): Promise<RecipeCreateInput> => {
  const lineToTitle = new Map(
    references.map((r) => [r.line.trim(), r.title.trim().toLowerCase()]),
  );
  const titleToId = await getCookbookRecipeIdsByTitle(db, book);

  return await withTransaction(db, async (tx) => {
    return {
      name: compact.name,
      meta: { url: null },
      yield: compact.recipe_yield ?? null,
      servings: compact.servings ?? null,
      sections: await Promise.all(
        compact.sections.map(async (section) => ({
          name: section.name ?? null,
          instructions: section.instructions.map((instruction) => ({
            instruction,
          })),
          ingredients: await Promise.all(
            section.ingredients.map(async (line) => {
              const parsed = wasm.parse_ingredient(line);
              const refTitle = lineToTitle.get(line.trim());
              const targetRecipeId = refTitle
                ? titleToId.get(refTitle)
                : undefined;
              // A reference whose target recipe exists in the book → link it.
              const ingredientId = targetRecipeId
                ? await findOrCreateRecipeLinkIngredient(tx, targetRecipeId)
                : (await findOrCreateIngredient(tx, parsed.name)).id;
              return {
                type: "ingredient" as const,
                ingredientId: unsafeIngredientId(ingredientId),
                recipeId: null,
                amounts: parsed.amounts,
              };
            }),
          ),
        })),
      ),
    };
  });
};

export const upsertCookbookRecipeWithRefs = async (
  compact: CompactRecipe,
  bookName: string,
  references: RecipeRef[],
  db: Database,
  actor: ActorContext,
) => {
  const recipeInput = await convertCookbookCompactToRecipeInput(
    compact,
    bookName,
    references,
    db,
  );

  // (book, title)-scoped upsert + "Book" provenance.
  return await upsertCookbookRecipe(recipeInput, bookName, db, actor);
};
