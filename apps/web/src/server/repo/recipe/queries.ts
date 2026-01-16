/**
 * Recipe analytics and query operations.
 * Ingredient co-occurrence, tags, and other analytics.
 */

import { desc } from "drizzle-orm";
import { unsafeIngredientId, unsafeRecipeId } from "~/schemas/identifiers";
import type {
  IngredientCooccurrence,
  IngredientEdge,
  IngredientNode,
} from "~/schemas/ingredient-cooccurrence";
import type { Database } from "~/server/db";
import { recipe } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";

/**
 * Get ingredient co-occurrence data for building a network graph.
 * Returns ingredients as nodes and edges between ingredients that appear together in recipes.
 */
export const getIngredientCooccurrence = async (
  db: Database,
  minEdgeWeight: number = 2,
): Promise<IngredientCooccurrence> => {
  const dbClient = getDb(db);

  // Get recipes with their ingredients (excludes soft-deleted)
  // Limited to most recently updated recipes to prevent unbounded queries
  const recipes = await dbClient.query.recipe.findMany({
    where: notDeleted(recipe),
    orderBy: desc(recipe.updatedAt),
    limit: 500,
    with: {
      sections: {
        with: {
          ingredients: {
            with: {
              ingredient: true,
            },
          },
        },
      },
    },
  });

  // Build ingredient -> recipe count map and recipe -> ingredients map
  const ingredientRecipeCount = new Map<string, number>();
  const ingredientNames = new Map<string, string>();
  const recipeIngredients = new Map<string, Set<string>>();

  for (const r of recipes) {
    const ingredientIds = new Set<string>();

    for (const section of r.sections) {
      for (const si of section.ingredients) {
        if (si.ingredient && !si.ingredient.recipeId) {
          // Only include regular ingredients, not recipe references
          ingredientIds.add(si.ingredient.id);
          ingredientNames.set(si.ingredient.id, si.ingredient.name);
        }
      }
    }

    // Update recipe count for each ingredient
    for (const ingId of ingredientIds) {
      ingredientRecipeCount.set(
        ingId,
        (ingredientRecipeCount.get(ingId) ?? 0) + 1,
      );
    }

    if (ingredientIds.size > 0) {
      recipeIngredients.set(r.id, ingredientIds);
    }
  }

  // Build co-occurrence matrix (count how many recipes each pair appears in together)
  // Also track which recipes contain each pair
  const cooccurrence = new Map<
    string,
    { count: number; recipes: Array<{ id: string; name: string }> }
  >();

  // Need to also track recipe names
  const recipeNames = new Map<string, string>();
  for (const r of recipes) {
    recipeNames.set(r.id, r.name);
  }

  for (const [recipeId, ingredientIds] of recipeIngredients) {
    const ids = Array.from(ingredientIds);
    const recipeName = recipeNames.get(recipeId) ?? "Unknown";
    // For each pair of ingredients in this recipe
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        // Create a canonical key (sorted to avoid duplicates)
        const key = [ids[i], ids[j]].sort().join("|");
        const existing = cooccurrence.get(key) ?? { count: 0, recipes: [] };
        existing.count += 1;
        existing.recipes.push({ id: recipeId, name: recipeName });
        cooccurrence.set(key, existing);
      }
    }
  }

  // Build nodes array (only include ingredients that have at least one edge)
  const ingredientsWithEdges = new Set<string>();
  const edges: IngredientEdge[] = [];

  for (const [key, data] of cooccurrence) {
    if (data.count >= minEdgeWeight) {
      const [source, target] = key.split("|") as [string, string];
      edges.push({
        source: unsafeIngredientId(source),
        target: unsafeIngredientId(target),
        weight: data.count,
        recipes: data.recipes.map((r) => ({
          id: unsafeRecipeId(r.id),
          name: r.name,
        })),
      });
      ingredientsWithEdges.add(source);
      ingredientsWithEdges.add(target);
    }
  }

  const nodes: IngredientNode[] = [];
  for (const id of ingredientsWithEdges) {
    nodes.push({
      id: unsafeIngredientId(id),
      name: ingredientNames.get(id) ?? "Unknown",
      recipeCount: ingredientRecipeCount.get(id) ?? 0,
    });
  }

  // Sort nodes by recipe count (most used first)
  nodes.sort((a, b) => b.recipeCount - a.recipeCount);

  return { nodes, edges };
};

/**
 * Get all unique tags used across recipes.
 * Used for tag autocomplete suggestions. Excludes soft-deleted recipes.
 */
export const getAllTags = async (db: Database): Promise<string[]> => {
  const dbClient = getDb(db);

  // Get all recipes with tags (excludes soft-deleted)
  const recipesWithTags = await dbClient.query.recipe.findMany({
    where: notDeleted(recipe),
    columns: { tags: true },
  });

  // Collect unique tags
  const tagSet = new Set<string>();
  for (const r of recipesWithTags) {
    if (r.tags) {
      for (const tag of r.tags) {
        tagSet.add(tag);
      }
    }
  }

  // Return sorted array of unique tags
  return Array.from(tagSet).sort();
};
