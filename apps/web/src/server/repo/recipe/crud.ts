/**
 * Recipe CRUD operations.
 * Core create, read, update, list operations for recipes.
 */

import type { CompactRecipe } from "@cubby/schemas/codec";
import type { ActorContext } from "@cubby/schemas/context";
import type { CookbookRecipe } from "@cubby/schemas/cookbook";
import { type RecipeId, unsafeRecipeId } from "@cubby/schemas/identifiers";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  RecipeCreateInput,
  RecipeOut,
  RecipeUpdateInput,
} from "@cubby/schemas/recipe";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { parseCompactRecipe } from "~/codec/parser";
import { getSortableFields } from "~/entities/entities";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  recipe,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  upsertCookbookRecipeFromCookbook,
  upsertRecipeFromCompact,
} from "~/server/repo/compactrecipe";
import {
  associatePendingImages,
  batchInsert,
  buildOrderBy,
  buildSearchConditions,
  executeListQueryWithCount,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  notDeleted,
  relations,
  unwrapDb,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { generateUniqueRecipeShortcode } from "~/server/repo/shortcode-utils";

import { dbRecipeToAPI } from "./helpers";
import type { RecipeFilters } from "./internal-types";
import {
  deleteAllSections,
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
 * Get many recipes by ID in one query. Returns the full ingredient graph (incl.
 * the `ingredient.Recipe` discriminator) but omits images — used by client-side
 * cost rollup to resolve sub-recipes (recipe-as-ingredient). Missing/deleted ids
 * are simply absent from the result.
 */
export const getRecipesByIDs = async (
  db: Database,
  ids: RecipeId[],
): Promise<RecipeOut[]> => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.recipe.findMany({
    where: and(inArray(recipe.id, ids), notDeleted(recipe)),
    ...relations.recipe.list,
  });
  return rows.map(dbRecipeToAPI);
};

/**
 * Find a recipe by shortcode and return its ID.
 */
const findRecipeByShortcode = async (
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
 * Titles of non-deleted recipes already imported from a given cookbook
 * (SourceType='Book', SourceData=book). Used by the import preview to flag
 * recipes that a re-import would update.
 */
export const getCookbookRecipeTitles = async (
  db: Database,
  book: string,
): Promise<string[]> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(
      eq(recipe.SourceType, "Book"),
      eq(recipe.SourceData, book),
      notDeleted(recipe),
    ),
    columns: { name: true },
  });
  return rows.map((r) => r.name);
};

/**
 * Distinct cookbooks (by `SourceData`) with their non-deleted recipe count.
 * Powers the cookbook browse index. No `Cookbook` table — a Book recipe's
 * provenance is the `SourceData` string, so the list is a GROUP BY over it.
 */
export const listCookbooks = async (
  db: Database,
): Promise<Array<{ book: string; recipeCount: number }>> => {
  const rows = await getDb(db)
    .select({
      book: recipe.SourceData,
      recipeCount: sql<number>`count(*)::int`,
    })
    .from(recipe)
    .where(and(eq(recipe.SourceType, "Book"), notDeleted(recipe)))
    .groupBy(recipe.SourceData)
    .orderBy(recipe.SourceData);
  // SourceData is non-null for Book rows in practice; guard the type anyway.
  return rows.filter(
    (r): r is { book: string; recipeCount: number } => r.book !== null,
  );
};

// Normalize a title for cross-recipe reference matching (trim + lowercase).
const normalizeTitle = (title: string): string => title.trim().toLowerCase();

/**
 * Map of normalized title → recipe id for a book's non-deleted recipes. Used to
 * resolve cookbook cross-references (`RecipeRef.title`) to the recipe they point
 * at. A whole book is bounded, so one query over all its recipes is fine.
 */
export const getCookbookRecipeIdsByTitle = async (
  db: Database,
  book: string,
): Promise<Map<string, string>> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(
      eq(recipe.SourceType, "Book"),
      eq(recipe.SourceData, book),
      notDeleted(recipe),
    ),
    columns: { id: true, name: true },
  });
  return new Map(rows.map((r) => [normalizeTitle(r.name), r.id]));
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
 * Insert a recipe extracted from an EPUB cookbook, scoped to its book so
 * re-imports upsert by (book, title). See {@link upsertCookbookRecipe}.
 *
 * The recipe's own `references` (recipe-epub's `resolve_references`) drive
 * sub-recipe linking: an ingredient line matching a reference whose target
 * recipe already exists in the book becomes a sub-recipe link instead of a flat
 * ingredient. Re-import after all the book's recipes exist to resolve forward
 * references.
 */
export const insertCookbookRecipe = (
  cookbookRecipe: CookbookRecipe,
  bookName: string,
  db: Database,
  actor: ActorContext,
) => {
  return upsertCookbookRecipeFromCookbook(cookbookRecipe, bookName, db, actor);
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
  const whereClause = buildSearchConditions(
    recipe,
    [{ column: recipe.name, term: filters.nameFilter }],
    [
      // Scope to one cookbook when browsing by source.
      filters.book
        ? and(
            eq(recipe.SourceType, "Book"),
            eq(recipe.SourceData, filters.book),
          )
        : undefined,
    ],
  );

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
      ...relations.recipe.list,
    }),
    dbClient
      .select({ count: sql<number>`count(*)::int` })
      .from(recipe)
      .where(whereClause),
  );

  const items = results.map(dbRecipeToAPI);
  return { data: items, count: totalCount };
};

// Provenance override for recipes whose source isn't a website URL (e.g. EPUB
// cookbooks → SourceType "Book"). When omitted, source derives from meta.url.
type RecipeProvenance = {
  sourceType: "Book" | "Website" | "Other";
  sourceData: string | null;
};

/**
 * Create a new recipe.
 */
export const createRecipe = async (
  db: Database,
  recipeInput: RecipeCreateInput,
  actor: ActorContext,
  provenance?: RecipeProvenance,
): Promise<RecipeOut> => {
  const sourceType =
    provenance?.sourceType ?? (recipeInput.meta?.url ? "Website" : "Other");
  const sourceData = provenance
    ? provenance.sourceData
    : recipeInput.meta?.url || null;
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

    const fullRecipe = await getRecipeByID(
      tx,
      unsafeRecipeId(createdRecipe.id),
    );
    if (!fullRecipe) {
      throw new Error("Failed to retrieve created recipe");
    }
    return fullRecipe;
  });
};

/**
 * Replace a recipe's sections wholesale: hard-delete the existing sections and
 * their ingredients, then insert the new ones. Hard-delete (not soft) because
 * replacing sections during an edit/re-import is internal churn, not a
 * user-facing deletion — soft-deleting here left dead RecipeSection /
 * RecipeSectionIngredient rows that accumulated on every re-upsert. Recipe-level
 * deletion remains a soft delete with audit logging in deleteRecipes().
 */
const replaceRecipeSections = async (
  tx: DrizzleTransaction,
  recipeId: string,
  sections: RecipeCreateInput["sections"],
) => {
  const existingSections = await tx.query.recipeSection.findMany({
    where: eq(recipeSection.recipeId, recipeId),
    columns: { id: true },
  });
  await deleteAllSections(
    tx,
    existingSections.map((s) => s.id),
  );

  for (const section of sections) {
    const createdSection = await insertAndReturn(tx, recipeSection, {
      recipeId,
      name: section.name,
      instructions:
        section.instructions?.map((instruction) => ({
          text: instruction.instruction,
        })) ?? [],
    });

    if (section.ingredients && section.ingredients.length > 0) {
      await batchInsert(
        tx,
        recipeSectionIngredient,
        section.ingredients.map((ing) => ({
          recipeSectionId: createdSection.id,
          ingredientId: ing.ingredientId as string,
          amounts: ing.amounts,
        })),
      );
    }
  }
};

/**
 * Shared upsert core: find an existing recipe with `matchWhere`; if found,
 * refresh its provenance and replace its sections; otherwise create it. The two
 * public upserts differ only in how they identify "the same recipe" and what
 * provenance they stamp.
 */
const upsertRecipeMatching = async (
  input: RecipeCreateInput,
  db: Database,
  actor: ActorContext,
  matchWhere: SQL | undefined,
  provenance: RecipeProvenance,
): Promise<{ id: string }> => {
  const existingRecipe = await getDb(db).query.recipe.findFirst({
    where: matchWhere,
  });

  if (!existingRecipe) {
    const created = await createRecipe(db, input, actor, provenance);
    return { id: created.id };
  }

  return await withTransaction(db, async (tx) => {
    const updatedRecipe = await updateAndReturn(
      tx,
      recipe,
      {
        SourceType: provenance.sourceType,
        SourceData: provenance.sourceData,
        updatedAt: new Date(),
      },
      eq(recipe.id, existingRecipe.id),
    );
    await replaceRecipeSections(tx, updatedRecipe.id, input.sections);
    return { id: updatedRecipe.id };
  });
};

/**
 * Upsert a recipe (create or update based on name match).
 *
 * Cookbook recipes are keyed by (book, title) via {@link upsertCookbookRecipe},
 * so they're excluded from the name match here — otherwise scraping a website
 * whose title matches a cookbook recipe would clobber the cookbook recipe.
 */
export const upsertRecipe = (
  input: RecipeCreateInput,
  db: Database,
  actor: ActorContext,
): Promise<{ id: string }> =>
  upsertRecipeMatching(
    input,
    db,
    actor,
    and(
      eq(recipe.name, input.name),
      notDeleted(recipe),
      sql`${recipe.SourceType} IS DISTINCT FROM 'Book'`,
    ),
    {
      sourceType: input.meta?.url ? "Website" : "Other",
      sourceData: input.meta?.url || null,
    },
  );

/**
 * Upsert a recipe extracted from an EPUB cookbook.
 *
 * Unlike {@link upsertRecipe} (which keys on name alone and stamps Website/Other
 * provenance), a cookbook recipe's identity is **(book, title)**: we match on
 * SourceType="Book" AND SourceData=bookName AND name. This keeps the same title
 * in two different books distinct, never collides with a website-scraped recipe
 * of the same name, and makes re-importing a book idempotent for stable titles.
 */
export const upsertCookbookRecipe = (
  input: RecipeCreateInput,
  bookName: string,
  db: Database,
  actor: ActorContext,
): Promise<{ id: string }> =>
  upsertRecipeMatching(
    input,
    db,
    actor,
    and(
      eq(recipe.name, input.name),
      eq(recipe.SourceType, "Book"),
      eq(recipe.SourceData, bookName),
      notDeleted(recipe),
    ),
    { sourceType: "Book", sourceData: bookName },
  );

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
    throw createAppError("RECIPE_NOT_FOUND", `Recipe with ID ${id} not found`);
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

/**
 * Soft-delete every non-deleted recipe imported from a given cookbook
 * (SourceType='Book', SourceData=book). Delegates to {@link deleteRecipes} so
 * the section/ingredient/image cascade, transaction, and audit trail are shared.
 * Returns the number of recipes deleted.
 */
export const deleteRecipesByCookbook = async (
  db: Database,
  book: string,
  actor: ActorContext,
): Promise<{ deleted: number }> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(
      eq(recipe.SourceType, "Book"),
      eq(recipe.SourceData, book),
      notDeleted(recipe),
    ),
    columns: { id: true },
  });
  const ids = rows.map((r) => unsafeRecipeId(r.id));
  await deleteRecipes(db, ids, actor);
  return { deleted: ids.length };
};
