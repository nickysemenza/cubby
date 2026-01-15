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
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import { upsertRecipeFromCompact } from "~/server/repo/compactrecipe";
import {
  associatePendingImages,
  batchInsert,
  buildOrderBy,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
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
    where: and(eq(recipe.id, id), notDeleted(recipe)),
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
    where: and(
      eq(recipe.shortcode, shortcode.toUpperCase()),
      notDeleted(recipe),
    ),
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
export const insertCompactRecipe = (
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

  // Build where conditions - always filter out deleted items
  const whereConditions = [
    notDeleted(recipe),
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

  // Check if recipe already exists by name (excludes soft-deleted)
  const existingRecipe = await dbClient.query.recipe.findFirst({
    where: and(eq(recipe.name, input.name), notDeleted(recipe)),
  });

  if (existingRecipe) {
    // Recipe exists - soft delete existing sections and recreate with new data
    // First soft delete ingredients that reference the sections
    const existingSections = await dbClient.query.recipeSection.findMany({
      where: eq(recipeSection.recipeId, existingRecipe.id),
      columns: { id: true },
    });

    if (existingSections.length > 0) {
      const sectionIds = existingSections.map((s) => s.id);
      const now = new Date();
      await dbClient
        .update(recipeSectionIngredient)
        .set({ deletedAt: now })
        .where(inArray(recipeSectionIngredient.recipeSectionId, sectionIds));

      // Now soft delete the sections
      await dbClient
        .update(recipeSection)
        .set({ deletedAt: now })
        .where(eq(recipeSection.recipeId, existingRecipe.id));
    }

    // Process ingredients for the update (same as in createRecipe)
    const processedSections = input.sections.map((section) => {
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
    });

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

/**
 * Soft delete recipes by setting deletedAt timestamp.
 * Also soft deletes related sections, ingredients, and images.
 */
export const deleteRecipes = async (
  db: Database,
  ids: RecipeId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  await withTransaction(db, async (tx) => {
    // Lock recipes and validate they exist and aren't already deleted
    // Prevents race conditions by acquiring row-level locks
    await lockAndValidateForDelete(tx, recipe, ids, "Recipe");

    const now = new Date();

    // Get all sections for these recipes
    const sections = await tx.query.recipeSection.findMany({
      where: inArray(recipeSection.recipeId, ids),
      columns: { id: true, recipeId: true },
    });

    const sectionIds = sections.map((s) => s.id);

    // Get counts of cascaded items for audit trail
    const cascadedImages = await tx.query.recipeImage.findMany({
      where: inArray(recipeImage.recipeId, ids),
      columns: { id: true, recipeId: true },
    });

    let cascadedIngredients: Array<{ recipeSectionId: string }> = [];
    if (sectionIds.length > 0) {
      cascadedIngredients = await tx.query.recipeSectionIngredient.findMany({
        where: inArray(recipeSectionIngredient.recipeSectionId, sectionIds),
        columns: { recipeSectionId: true },
      });
    }

    // Group cascaded items by recipe ID for audit logging
    const sectionsByRecipe = new Map<string, number>();
    const ingredientsByRecipe = new Map<string, number>();
    const imagesByRecipe = new Map<string, number>();

    // Map sections to recipes
    const sectionToRecipe = new Map<string, string>();
    for (const section of sections) {
      sectionToRecipe.set(section.id, section.recipeId);
      sectionsByRecipe.set(
        section.recipeId,
        (sectionsByRecipe.get(section.recipeId) ?? 0) + 1,
      );
    }

    // Count ingredients per recipe (via section mapping)
    for (const ing of cascadedIngredients) {
      const recipeId = sectionToRecipe.get(ing.recipeSectionId);
      if (recipeId) {
        ingredientsByRecipe.set(
          recipeId,
          (ingredientsByRecipe.get(recipeId) ?? 0) + 1,
        );
      }
    }

    // Count images per recipe
    for (const img of cascadedImages) {
      imagesByRecipe.set(
        img.recipeId,
        (imagesByRecipe.get(img.recipeId) ?? 0) + 1,
      );
    }

    // Soft delete recipe section ingredients
    if (sectionIds.length > 0) {
      await tx
        .update(recipeSectionIngredient)
        .set({ deletedAt: now })
        .where(inArray(recipeSectionIngredient.recipeSectionId, sectionIds));
    }

    // Soft delete recipe sections
    await tx
      .update(recipeSection)
      .set({ deletedAt: now })
      .where(inArray(recipeSection.recipeId, ids));

    // Soft delete recipe images
    await tx
      .update(recipeImage)
      .set({ deletedAt: now })
      .where(inArray(recipeImage.recipeId, ids));

    // Soft delete recipes
    await tx
      .update(recipe)
      .set({ deletedAt: now })
      .where(inArray(recipe.id, ids));

    // Log audit entries with cascaded item counts (batch operation)
    const auditEntries = ids.map((id) => {
      const sectionCount = sectionsByRecipe.get(id) ?? 0;
      const ingredientCount = ingredientsByRecipe.get(id) ?? 0;
      const imageCount = imagesByRecipe.get(id) ?? 0;

      const changes: Record<string, { from: unknown; to: unknown }> = {};
      if (sectionCount > 0) {
        changes.cascadedSections = { from: sectionCount, to: 0 };
      }
      if (ingredientCount > 0) {
        changes.cascadedIngredients = { from: ingredientCount, to: 0 };
      }
      if (imageCount > 0) {
        changes.cascadedImages = { from: imageCount, to: 0 };
      }

      return {
        entityType: "recipe" as const,
        entityId: id,
        action: "delete" as const,
        changes: Object.keys(changes).length > 0 ? changes : undefined,
      };
    });

    await logAuditEntries(tx, actor, auditEntries);
  });
};
