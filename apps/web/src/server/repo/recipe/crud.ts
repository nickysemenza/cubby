/**
 * Recipe CRUD operations.
 * Core create, read, update, list operations for recipes.
 */

import type { ActorContext } from "@cubby/schemas/context";
import {
  type CookbookId,
  type RecipeId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
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
import { getSortableFields } from "~/entities/entities";
import { recipeOutSignature } from "~/lib/recipe-signature";
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
  associatePendingImages,
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
  type RecipeProvenance,
  recipeSourceToColumns,
  webProvenance,
} from "./source";
import {
  createSectionWithIngredients,
  handleSectionUpdates,
  replaceRecipeSections,
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
 * Titles of non-deleted recipes already linked to a cookbook. Used by the import
 * preview to flag recipes that a re-import would update, and by reprocess to tell
 * already-imported recipes from importable extras.
 */
export const getCookbookRecipeTitles = async (
  db: Database,
  cookbookId: CookbookId,
): Promise<string[]> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
    columns: { name: true },
  });
  return rows.map((r) => r.name);
};

/**
 * A cookbook's non-deleted recipes with their id and content signature — lets
 * the import preview show "no changes" vs "will update" per title and link to
 * the existing Cubby recipe. Title is the per-book key.
 */
export const getCookbookRecipesForDiff = async (
  db: Database,
  cookbookId: CookbookId,
): Promise<Array<{ title: string; id: string; sig: string }>> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
    columns: { id: true, name: true },
  });
  const recipes = await getRecipesByIDs(
    db,
    rows.map((r) => unsafeRecipeId(r.id)),
  );
  const byId = new Map(recipes.map((r) => [r.id, r]));
  return rows.flatMap((r) => {
    const full = byId.get(unsafeRecipeId(r.id));
    return full
      ? [{ title: r.name, id: r.id, sig: recipeOutSignature(full) }]
      : [];
  });
};

// Normalize a title for cross-recipe reference matching (trim + lowercase).
const normalizeTitle = (title: string): string => title.trim().toLowerCase();

/**
 * Map of normalized title → recipe id for a cookbook's non-deleted recipes. Used
 * to resolve cookbook cross-references (`RecipeRef.title`) to the recipe they
 * point at. A whole book is bounded, so one query over all its recipes is fine.
 */
export const getCookbookRecipeIdsByTitle = async (
  db: Database,
  cookbookId: CookbookId,
): Promise<Map<string, RecipeId>> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
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
 * Page ids (SourceData) of every non-deleted Notion-synced recipe — lets the
 * import preview flag which pages already exist (new vs. will-update).
 */
export const getNotionRecipePageIds = async (
  db: Database,
): Promise<string[]> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(eq(recipe.SourceType, "Notion"), notDeleted(recipe)),
    columns: { SourceData: true },
  });
  return rows.map((r) => r.SourceData).filter((s): s is string => s !== null);
};

/**
 * Every non-deleted Notion-synced recipe with its page id and full content — so
 * the import preview can compare against what a re-import would produce ("no
 * changes" vs "will update") and link to the existing Cubby recipe.
 */
export const getNotionRecipesForDiff = async (
  db: Database,
): Promise<Array<{ id: string; pageId: string; recipe: RecipeOut }>> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(eq(recipe.SourceType, "Notion"), notDeleted(recipe)),
    columns: { id: true, SourceData: true },
  });
  const recipes = await getRecipesByIDs(
    db,
    rows.map((r) => unsafeRecipeId(r.id)),
  );
  const byId = new Map(recipes.map((r) => [r.id, r]));
  return rows.flatMap((r) => {
    const full = byId.get(unsafeRecipeId(r.id));
    return r.SourceData && full
      ? [{ id: r.id, pageId: r.SourceData, recipe: full }]
      : [];
  });
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

  // Build where conditions - always filter out deleted items. Scope to one
  // cookbook by FK id when browsing its detail page.
  const whereClause = buildSearchConditions(
    recipe,
    [{ column: recipe.name, term: filters.nameFilter }],
    [
      filters.cookbookId
        ? eq(recipe.cookbookId, filters.cookbookId)
        : undefined,
    ],
  );

  // Build orderBy using central sortableFields config. costTotal/caloriesTotal
  // live in the `totals` jsonb (not real columns), so sort them via a jsonb
  // expression; everything else goes through the generic buildOrderBy.
  const jsonbSortKey =
    sort.orderBy === "costTotal"
      ? "costTotal"
      : sort.orderBy === "caloriesTotal"
        ? "caloriesTotal"
        : null;
  const orderByClause = jsonbSortKey
    ? [
        sort.direction === "asc"
          ? sql`(${recipe.totals}->>${jsonbSortKey})::numeric asc nulls last`
          : sql`(${recipe.totals}->>${jsonbSortKey})::numeric desc nulls last`,
      ]
    : buildOrderBy(recipe, sort, [...getSortableFields("recipe")]);

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

// A cookbook the importer is writing into: its FK id plus its name (stamped onto
// each recipe's SourceData). Created up-front by `upsertCookbook` (cookbook repo).
export type CookbookRef = { id: CookbookId; name: string };

/**
 * Create a new recipe.
 */
export const createRecipe = async (
  db: Database,
  recipeInput: RecipeCreateInput,
  actor: ActorContext,
  provenance?: RecipeProvenance,
): Promise<RecipeOut> => {
  const sourceColumns = recipeSourceToColumns(
    provenance ?? webProvenance(recipeInput.meta?.url ?? null),
  );
  const { pendingImageIds } = recipeInput;

  // Create the recipe in a transaction
  return await withTransaction(db, async (tx) => {
    // Generate unique shortcode
    const shortcode = await generateUniqueRecipeShortcode(tx);

    // Create the main recipe
    const createdRecipe = await insertAndReturn(tx, recipe, {
      name: recipeInput.name,
      shortcode,
      ...sourceColumns,
      yield: recipeInput.yield ?? null,
      servings: recipeInput.servings ?? null,
      tags: recipeInput.tags ?? null,
      notes: recipeInput.notes ?? null,
    });
    const createdRecipeId = unsafeRecipeId(createdRecipe.id);

    for (const [i, section] of recipeInput.sections.entries()) {
      await createSectionWithIngredients(tx, createdRecipeId, section, i);
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

    const fullRecipe = await getRecipeByID(tx, createdRecipeId);
    if (!fullRecipe) {
      throw new Error("Failed to retrieve created recipe");
    }
    return fullRecipe;
  });
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
): Promise<{ id: RecipeId }> => {
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
        ...recipeSourceToColumns(provenance),
        // Like sections, notes are replaced from the import source on re-import
        // (a manual edit doesn't survive a re-import).
        notes: input.notes ?? null,
        updatedAt: new Date(),
      },
      eq(recipe.id, existingRecipe.id),
    );
    await replaceRecipeSections(
      tx,
      unsafeRecipeId(updatedRecipe.id),
      input.sections,
    );
    return { id: updatedRecipe.id };
  });
};

/**
 * Upsert a recipe (create or update based on name match).
 *
 * Cookbook recipes are keyed by (cookbookId, title) via {@link upsertCookbookRecipe},
 * so they're excluded from the name match here — otherwise scraping a website
 * whose title matches a cookbook recipe would clobber the cookbook recipe.
 */
export const upsertRecipe = (
  input: RecipeCreateInput,
  db: Database,
  actor: ActorContext,
): Promise<{ id: RecipeId }> =>
  upsertRecipeMatching(
    input,
    db,
    actor,
    and(
      eq(recipe.name, input.name),
      notDeleted(recipe),
      sql`${recipe.SourceType} IS DISTINCT FROM 'Book'`,
    ),
    webProvenance(input.meta?.url ?? null),
  );

/**
 * Upsert a recipe extracted from an EPUB cookbook.
 *
 * Unlike {@link upsertRecipe} (which keys on name alone and stamps Website/Other
 * provenance), a cookbook recipe's identity is **(cookbookId, title)**: we match
 * on cookbookId AND name, stamp the FK, and sync SourceData to the cookbook name.
 * This keeps the same title in two different books distinct, never collides with a
 * website-scraped recipe of the same name, and makes re-importing a book
 * idempotent for stable titles.
 */
export const upsertCookbookRecipe = (
  input: RecipeCreateInput,
  cookbookRef: CookbookRef,
  db: Database,
  actor: ActorContext,
): Promise<{ id: RecipeId }> =>
  upsertRecipeMatching(
    input,
    db,
    actor,
    and(
      eq(recipe.name, input.name),
      eq(recipe.cookbookId, cookbookRef.id),
      notDeleted(recipe),
    ),
    {
      sourceType: "Book",
      sourceData: cookbookRef.name,
      cookbookId: cookbookRef.id,
    },
  );

/**
 * Upsert a recipe synced from a Notion page.
 *
 * A Notion recipe's identity is its **page id** (stored in SourceData) — not its
 * title — so a renamed page still updates the same row and never collides with a
 * same-named web/manual recipe (the `Recipe_name_key` index exempts Notion). This
 * is the Notion analogue of {@link upsertCookbookRecipe}.
 */
export const upsertNotionRecipe = (
  input: RecipeCreateInput,
  pageId: string,
  db: Database,
  actor: ActorContext,
): Promise<{ id: RecipeId }> =>
  upsertRecipeMatching(
    input,
    db,
    actor,
    and(
      eq(recipe.SourceType, "Notion"),
      eq(recipe.SourceData, pageId),
      notDeleted(recipe),
    ),
    {
      sourceType: "Notion",
      sourceData: pageId,
    },
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
 * Soft-delete every non-deleted recipe linked to a cookbook. Delegates to
 * {@link deleteRecipes} so the section/ingredient/image cascade, transaction, and
 * audit trail are shared. Returns the number of recipes deleted. (The Cookbook
 * row itself is left intact; deleting recipes doesn't delete the source.)
 */
export const deleteRecipesByCookbook = async (
  db: Database,
  cookbookId: CookbookId,
  actor: ActorContext,
): Promise<{ deleted: number }> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
    columns: { id: true },
  });
  const ids = rows.map((r) => unsafeRecipeId(r.id));
  await deleteRecipes(db, ids, actor);
  return { deleted: ids.length };
};
