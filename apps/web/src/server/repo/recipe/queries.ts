/**
 * Recipe analytics and query operations.
 * Ingredient co-occurrence, tags, and other analytics.
 */

import type { CookbookId, IngredientId } from "@cubby/schemas/identifiers";
import { unsafeIngredientId, unsafeRecipeId } from "@cubby/schemas/identifiers";
import type {
  IngredientCooccurrence,
  IngredientEdge,
  IngredientNode,
} from "@cubby/schemas/ingredient-cooccurrence";
import type { IngredientUsage } from "@cubby/schemas/ingredient-usage";
import type {
  RecipeDepEdge,
  RecipeDependencyGraph,
  RecipeDepNode,
} from "@cubby/schemas/recipe-dependency-graph";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  cookbook,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
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
        // Exclude soft-deleted sections/usages so the cooccurrence counts don't
        // include ingredients that were removed from these (live) recipes.
        where: notDeleted(recipeSection),
        with: {
          ingredients: {
            // Only the nested ingredient's id/name/recipeId is read below — never
            // a line-level column (rawLine, amounts). Drop all RSI columns so the
            // ~thousands of joined lines don't marshal the heavy rawLine/amounts
            // back through Hyperdrive; Drizzle still pulls the FK to hydrate the
            // relation.
            columns: {},
            where: notDeleted(recipeSectionIngredient),
            with: {
              ingredient: { columns: { id: true, name: true, recipeId: true } },
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

// Map of cookbook id → display name, for labelling/colouring graph nodes.
const getCookbookNameMap = async (
  db: Database,
): Promise<Map<CookbookId, string>> => {
  const rows = await getDb(db).query.cookbook.findMany({
    where: notDeleted(cookbook),
    columns: { id: true, name: true },
  });
  return new Map(rows.map((c) => [c.id, c.name]));
};

/**
 * Build the recipe-as-ingredient dependency graph. Each edge is parent → sub
 * ("uses / depends on"): a recipe that contains an ingredient whose `recipeId`
 * points at another recipe. Optionally scoped to one cookbook — sub-recipes that
 * fall outside that cookbook are still emitted as `external` nodes so their
 * inbound edge isn't dangling.
 */
export const getRecipeDependencyGraph = async (
  db: Database,
  cookbookId?: CookbookId,
): Promise<RecipeDependencyGraph> => {
  const dbClient = getDb(db);
  const cookbookNames = await getCookbookNameMap(db);
  const nameFor = (id: CookbookId | null) =>
    id ? (cookbookNames.get(id) ?? null) : null;

  const recipes = await dbClient.query.recipe.findMany({
    where: cookbookId
      ? and(notDeleted(recipe), eq(recipe.cookbookId, cookbookId))
      : notDeleted(recipe),
    columns: { id: true, name: true, cookbookId: true },
    with: {
      sections: {
        // Exclude soft-deleted sections/usages so removed sub-recipe links
        // don't produce phantom edges (matches getIngredientCooccurrence).
        where: notDeleted(recipeSection),
        with: {
          ingredients: {
            // Only si.ingredient is read — drop the heavy RSI line columns
            // (rawLine, amounts) from the marshalled payload.
            columns: {},
            where: notDeleted(recipeSectionIngredient),
            with: {
              ingredient: { columns: { recipeId: true, deletedAt: true } },
            },
          },
        },
      },
    },
  });

  const nodes = new Map<string, RecipeDepNode>();
  for (const r of recipes) {
    nodes.set(r.id, {
      id: r.id,
      name: r.name,
      cookbookId: r.cookbookId,
      cookbookName: nameFor(r.cookbookId),
      external: false,
    });
  }

  const edges: RecipeDepEdge[] = [];
  const externalSubIds = new Set<string>();
  for (const r of recipes) {
    const seen = new Set<string>();
    for (const section of r.sections) {
      for (const si of section.ingredients) {
        const ing = si.ingredient;
        const subId = ing?.recipeId;
        // Skip soft-deleted pointer rows so they don't create phantom edges
        // (mirrors getIngredientUsage's deletedAt guard).
        if (!subId || ing?.deletedAt || seen.has(subId)) continue;
        seen.add(subId);
        edges.push({ source: r.id, target: subId });
        if (!nodes.has(subId)) externalSubIds.add(subId);
      }
    }
  }

  // Resolve names for sub-recipes outside the current scope (cookbook filter).
  if (externalSubIds.size > 0) {
    const externals = await dbClient.query.recipe.findMany({
      where: and(
        notDeleted(recipe),
        inArray(recipe.id, [...externalSubIds].map(unsafeRecipeId)),
      ),
      columns: { id: true, name: true, cookbookId: true },
    });
    for (const e of externals) {
      nodes.set(e.id, {
        id: e.id,
        name: e.name,
        cookbookId: e.cookbookId,
        cookbookName: nameFor(e.cookbookId),
        external: true,
      });
    }
  }

  // Drop edges whose target couldn't be resolved (e.g. soft-deleted sub-recipe).
  const resolved = edges.filter((e) => nodes.has(e.target));
  return { nodes: [...nodes.values()], edges: resolved };
};

/**
 * Count how many distinct recipes use each real ingredient, optionally scoped to
 * one cookbook. Excludes sub-recipe pointers (ingredient.recipeId set) and
 * soft-deleted ingredients. Rows are sorted most-used first.
 */
export const getIngredientUsage = async (
  db: Database,
  cookbookId?: CookbookId,
): Promise<IngredientUsage> => {
  const dbClient = getDb(db);
  const recipes = await dbClient.query.recipe.findMany({
    where: cookbookId
      ? and(notDeleted(recipe), eq(recipe.cookbookId, cookbookId))
      : notDeleted(recipe),
    columns: { id: true },
    with: {
      sections: {
        // Exclude soft-deleted sections/usages so usage counts don't include
        // ingredients removed from these live recipes (matches cooccurrence).
        where: notDeleted(recipeSection),
        with: {
          ingredients: {
            // Only si.ingredient is read — drop the heavy RSI line columns
            // (rawLine, amounts) from the marshalled payload.
            columns: {},
            where: notDeleted(recipeSectionIngredient),
            with: {
              ingredient: {
                columns: {
                  id: true,
                  name: true,
                  recipeId: true,
                  deletedAt: true,
                },
              },
            },
          },
        },
      },
    },
  });

  const recipeCount = new Map<IngredientId, number>();
  const names = new Map<IngredientId, string>();
  for (const r of recipes) {
    const ids = new Set<IngredientId>();
    for (const section of r.sections) {
      for (const si of section.ingredients) {
        const ing = si.ingredient;
        // Real, live ingredients only — skip sub-recipe pointers + deleted rows.
        if (ing && !ing.recipeId && !ing.deletedAt) {
          ids.add(ing.id);
          names.set(ing.id, ing.name);
        }
      }
    }
    for (const id of ids) {
      recipeCount.set(id, (recipeCount.get(id) ?? 0) + 1);
    }
  }

  const rows = [...recipeCount.entries()]
    .map(([ingredientId, count]) => ({
      ingredientId,
      name: names.get(ingredientId) ?? "Unknown",
      recipeCount: count,
    }))
    .sort((a, b) => b.recipeCount - a.recipeCount);

  return { rows, totalRecipes: recipes.length };
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
