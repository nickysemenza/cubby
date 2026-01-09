/**
 * Recipe CRUD operations.
 * Core create, read, update, list operations for recipes.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import type { CompactRecipe } from "~/codec/codec";
import { parseCompactRecipe } from "~/codec/parser";
import { getSortableFields } from "~/entities/entities";
import type { ActorContext } from "~/schemas/context";
import { type RecipeId, unsafeRecipeId } from "~/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "~/schemas/pagination";
import type {
  RecipeCreateInput,
  RecipeOut,
  RecipeUpdateInput,
} from "~/schemas/recipe";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  recipe,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import { upsertRecipeFromCompact } from "~/server/repo/compactrecipe";
import {
  associatePendingImages,
  batchInsert,
  buildOrderBy,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  insertAndReturn,
  relations,
  unwrapDb,
  withTransaction,
} from "~/server/repo/database-helpers";
import { generateUniqueRecipeShortcode } from "~/server/repo/shortcode-utils";

import { dbRecipeToAPI } from "./helpers";
import type { RecipeFilters } from "./internal-types";
import {
  handleSectionUpdates,
  processIngredients,
  updateRecipeBasicProperties,
  updateRecipeImages,
} from "./update-helpers";

/**
 * Get a recipe by ID.
 */
export const getRecipeByID = async (
  db: Database | DrizzleTransaction,
  id: RecipeId,
): Promise<RecipeOut | null> => {
  const res = await unwrapDb(db).query.recipe.findFirst({
    where: eq(recipe.id, id),
    ...relations.recipe.full,
  });
  return res === null || res === undefined ? null : dbRecipeToAPI(res);
};

/**
 * Find a recipe by shortcode and return its ID.
 */
export const findRecipeByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<RecipeId | null> => {
  const rec = await getDb(db).query.recipe.findFirst({
    where: eq(recipe.shortcode, shortcode.toUpperCase()),
    columns: { id: true },
  });
  return rec ? unsafeRecipeId(rec.id) : null;
};

/**
 * Get a recipe by shortcode.
 */
export const getRecipeByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<RecipeOut | null> => {
  const recipeId = await findRecipeByShortcode(db, shortcode);
  if (!recipeId) {
    return null;
  }
  return getRecipeByID(db, recipeId);
};

/**
 * Insert a recipe from compact format.
 */
export const insertCompactRecipe = async (
  recipeInput: CompactRecipe,
  db: Database,
  actor: ActorContext,
) => {
  const parsed = parseCompactRecipe(recipeInput);
  return upsertRecipeFromCompact(parsed, db, actor);
};

/**
 * List recipes with filters, sorting, and pagination.
 */
export const recipeList = async (
  db: Database,
  filters: RecipeFilters,
  sort: SortParams,
  pagination: PaginationParams,
) => {
  const dbClient = getDb(db);

  // Build where conditions
  const whereConditions = [
    filters.nameFilter
      ? formatSearchTerm(recipe.name, filters.nameFilter)
      : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);

  const whereClause =
    whereConditions.length > 0 ? and(...whereConditions) : undefined;

  // Build orderBy using central sortableFields config
  const orderByClause = buildOrderBy(recipe, sort, [
    ...getSortableFields("recipe"),
  ]);

  const { take, skip } = buildTakeSkip(pagination);

  // Execute both queries and transform results
  const { data: results, count: totalCount } = await executeListQueryWithCount(
    dbClient.query.recipe.findMany({
      where: whereClause,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
      ...relations.recipe.full,
    }),
    dbClient
      .select({ count: sql<number>`count(*)::int` })
      .from(recipe)
      .where(whereClause),
  );

  const items = results.map(dbRecipeToAPI);
  return { data: items, count: totalCount };
};

/**
 * Create a new recipe.
 */
export const createRecipe = async (
  db: Database,
  recipeInput: RecipeCreateInput,
  actor: ActorContext,
): Promise<RecipeOut> => {
  const sourceType = recipeInput.meta?.url ? "Website" : "Other";
  const sourceData = recipeInput.meta?.url || null;
  const { pendingImageIds } = recipeInput;

  // Create the recipe in a transaction
  return await withTransaction(db, async (tx) => {
    // Generate unique shortcode
    const shortcode = await generateUniqueRecipeShortcode(tx);

    // Process all ingredients first
    const processedSections = await Promise.all(
      recipeInput.sections.map(async (section) => {
        const processedIngredients = section.ingredients
          ? await processIngredients(tx, section.ingredients)
          : [];

        return {
          name: section.name,
          processedIngredients,
          instructions: section.instructions,
        };
      }),
    );

    // Create the main recipe
    const createdRecipe = await insertAndReturn(tx, recipe, {
      name: recipeInput.name,
      shortcode,
      SourceType: sourceType,
      SourceData: sourceData,
      yield: recipeInput.yield ?? null,
      servings: recipeInput.servings ?? null,
      tags: recipeInput.tags ?? null,
    });

    // Create sections and their ingredients
    for (const section of processedSections) {
      const createdSection = await insertAndReturn(tx, recipeSection, {
        recipeId: createdRecipe.id,
        name: section.name,
        instructions:
          section.instructions?.map((instruction) => ({
            text: instruction.instruction,
          })) ?? [],
      });

      // Create ingredients for this section
      if (section.processedIngredients.length > 0) {
        await batchInsert(
          tx,
          recipeSectionIngredient,
          section.processedIngredients.map((ing) => ({
            recipeSectionId: createdSection.id,
            ingredientId: ing.ingredientId as string,
            amounts: ing.amounts,
          })),
        );
      }
    }

    // Associate images if provided
    if (pendingImageIds && pendingImageIds.length > 0) {
      await associatePendingImages(
        tx,
        recipeImage,
        "recipeId",
        createdRecipe.id,
        pendingImageIds,
      );
    }

    // Log audit entry
    await logAuditEntry(tx, actor, {
      entityType: "recipe",
      entityId: createdRecipe.id,
      action: "create",
    });

    const fullRecipe = await getRecipeByID(tx, createdRecipe.id as RecipeId);
    if (!fullRecipe) {
      throw new Error("Failed to retrieve created recipe");
    }
    return fullRecipe;
  });
};

/**
 * Upsert a recipe (create or update based on name match).
 */
export const upsertRecipe = async (
  input: RecipeCreateInput,
  db: Database,
  actor: ActorContext,
): Promise<{ id: string }> => {
  const dbClient = getDb(db);

  // Check if recipe already exists by name
  const existingRecipe = await dbClient.query.recipe.findFirst({
    where: eq(recipe.name, input.name),
  });

  if (existingRecipe) {
    // Recipe exists - delete existing sections and recreate with new data
    // First delete ingredients that reference the sections
    const existingSections = await dbClient.query.recipeSection.findMany({
      where: eq(recipeSection.recipeId, existingRecipe.id),
      columns: { id: true },
    });

    if (existingSections.length > 0) {
      const sectionIds = existingSections.map((s) => s.id);
      await dbClient
        .delete(recipeSectionIngredient)
        .where(inArray(recipeSectionIngredient.recipeSectionId, sectionIds));

      // Now safe to delete the sections
      await dbClient
        .delete(recipeSection)
        .where(eq(recipeSection.recipeId, existingRecipe.id));
    }

    // Process ingredients for the update (same as in createRecipe)
    const processedSections = await Promise.all(
      input.sections.map(async (section) => {
        const processedIngredients = (section.ingredients || []).map(
          (ingredientInput) => ({
            ingredientId: ingredientInput.ingredientId,
            amounts: ingredientInput.amounts,
          }),
        );

        return {
          name: section.name,
          processedIngredients,
          instructions: section.instructions,
        };
      }),
    );

    // Update the recipe with new data
    const [updatedRecipe] = await dbClient
      .update(recipe)
      .set({
        SourceType: input.meta?.url ? "Website" : "Other",
        SourceData: input.meta?.url || null,
        updatedAt: new Date(),
      })
      .where(eq(recipe.id, existingRecipe.id))
      .returning();

    if (!updatedRecipe) {
      throw new Error("Failed to update recipe");
    }

    // Create new sections
    for (const section of processedSections) {
      const [createdSection] = await dbClient
        .insert(recipeSection)
        .values({
          recipeId: updatedRecipe.id,
          name: section.name,
          instructions:
            section.instructions?.map((instruction) => ({
              text: instruction.instruction,
            })) ?? [],
        })
        .returning();

      if (!createdSection) {
        throw new Error("Failed to create recipe section");
      }

      // Create ingredients for this section
      if (section.processedIngredients.length > 0) {
        await dbClient.insert(recipeSectionIngredient).values(
          section.processedIngredients.map((ing) => ({
            recipeSectionId: createdSection.id,
            ingredientId: ing.ingredientId as string,
            amounts: ing.amounts,
          })),
        );
      }
    }

    return { id: updatedRecipe.id };
  } else {
    // Recipe doesn't exist - create new one
    const created = await createRecipe(db, input, actor);
    return { id: created.id };
  }
};

/**
 * Update an existing recipe.
 */
export const updateRecipe = async (
  db: Database,
  id: RecipeId,
  updates: RecipeUpdateInput["data"],
  actor: ActorContext,
): Promise<RecipeOut> => {
  // Check if recipe exists
  const existingRecipe = await getDb(db).query.recipe.findFirst({
    where: eq(recipe.id, id),
    with: {
      sections: {
        with: {
          ingredients: true,
        },
      },
    },
  });

  if (!existingRecipe) {
    throw new Error(`Recipe with ID ${id} not found`);
  }

  // Store before state for audit logging
  const beforeState = { name: existingRecipe.name };

  // Update in a transaction
  return await withTransaction(db, async (tx) => {
    await updateRecipeBasicProperties(tx, id, updates, existingRecipe);
    await updateRecipeImages(tx, id, updates);

    if (updates.sections) {
      await handleSectionUpdates(tx, id, updates.sections, existingRecipe);
    }

    const fullRecipe = await getRecipeByID(tx, id);
    if (!fullRecipe) {
      throw new Error("Failed to retrieve updated recipe");
    }

    // Log audit entry with changes
    const afterState = { name: fullRecipe.name };
    const changes = computeChanges(beforeState, afterState, ["name"]);
    if (changes) {
      await logAuditEntry(tx, actor, {
        entityType: "recipe",
        entityId: id,
        action: "update",
        changes,
      });
    }

    return fullRecipe;
  });
};
