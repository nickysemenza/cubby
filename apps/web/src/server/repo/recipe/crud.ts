/**
 * Recipe CRUD operations.
 * Core create, read, update, list operations for recipes.
 */

import type { ActorContext } from "@cubby/schemas/context";
import type {
  ImpactItem,
  OperationDisposition,
} from "@cubby/schemas/entity-integrity";
import {
  type CookbookId,
  type RecipeId,
  type RecipeShortcode,
  unsafeRecipeId,
  unsafeRecipeShortcode,
} from "@cubby/schemas/identifiers";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import type {
  RecipeCreateInput,
  RecipeGraphOut,
  RecipeOut,
  RecipeUpdateInput,
} from "@cubby/schemas/recipe";
import { recipeSortableFields } from "@cubby/schemas/recipe";
import {
  type AnyColumn,
  and,
  arrayOverlaps,
  eq,
  inArray,
  isNotNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { alias } from "drizzle-orm/pg-core";
import { countBy, sum, uniq } from "es-toolkit";
import { collectSubRecipeIds } from "~/lib/recipe-graph";
import { recipeOutSignature } from "~/lib/recipe-signature";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  image,
  ingredient,
  meal,
  mealRecipe,
  recipe,
  recipeImage,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { runWithConflictRecovery } from "~/server/errors/db-errors";
import {
  buildCascadeAuditEntries,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  associatePendingImages,
  auditDateWhereConditions,
  buildOrderBy,
  buildSearchConditions,
  countWhere,
  eqAnyOrPresence,
  executeListQueryWithCount,
  formatSearchTerm,
  getDb,
  idSetPresence,
  lockAndValidateForDelete,
  notDeleted,
  presenceCondition,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { softDeleteEntityEmbeddingsTx } from "~/server/repo/entity-embedding";
import {
  countByTarget,
  impact,
  present,
  sideEffect,
} from "~/server/repo/impact";
import { relatedWhereConditions } from "~/server/repo/related-view";
import {
  resolveAllPresent,
  resolveLiveShortcode,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { TraceNames, withTrace } from "~/server/tracing";

export const RECIPE_DELETE_EDGE_POLICY = {
  "RecipeSection.recipeId": {
    code: "soft-delete-owned-row",
    effect: "soft-delete",
    description:
      "A recipe's sections, and their ingredient lines, are soft-deleted along with it.",
  },
  "Ingredient.recipeId": {
    code: "preserve-sub-recipe-pointer",
    effect: "preserve",
    description:
      "A deleted recipe's sub-recipe pointer is left untouched — parent recipes are recomputed and re-resolved rather than having this edge cascaded or guarded.",
  },
  "MealRecipe.recipeId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Meal-plan associations are soft-deleted with the recipe; the meals themselves are not.",
  },
  "RecipeImage.recipeId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the recipe; the underlying images are not.",
  },
} as const satisfies IncomingEdgePolicy<"recipe", OperationDisposition>;

import {
  dbRecipeToAPI,
  dbRecipeToAPIGraph,
  dbRecipeToListAPI,
  liveMealCountForRecipeSql,
  recipeListCoverImageRelation,
} from "./helpers";
import type { RecipeFilters } from "./internal-types";
import {
  type RecipeProvenance,
  recipeSourceToColumns,
  webProvenance,
} from "./source";
import { findParentRecipeIdsBatch } from "./totals";
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
 * the `ingredient.recipe` discriminator) but omits images — used by client-side
 * cost rollup to resolve sub-recipes (recipe-as-ingredient). Missing/deleted ids
 * are simply absent from the result.
 */
export const getRecipesByIDs = async (
  db: Database,
  ids: RecipeId[],
): Promise<RecipeGraphOut[]> => {
  if (ids.length === 0) return [];
  return withTrace(TraceNames.db("recipe.getRecipesByIDs"), async (span) => {
    span.setAttribute("db.table", "recipe");
    span.setAttribute("db.requested_count", ids.length);
    const rows = await getDb(db).query.recipe.findMany({
      where: and(inArray(recipe.id, ids), notDeleted(recipe)),
      ...relations.recipe.list,
    });
    span.setAttribute("db.result_count", rows.length);
    return rows.map(dbRecipeToAPIGraph);
  });
};

/**
 * Every sub-recipe transitively reachable from `roots`, keyed by shortcode.
 *
 * Both engines that recurse into sub-recipes need this closure — costing to
 * roll totals up, needs-expansion to flatten ingredients down — so it lives
 * here rather than being BFS'd separately in each service.
 *
 * Short-circuits when no root references a sub-recipe at all: most recipes are
 * flat, and the "what can I make?" fan-out evaluates hundreds of them per call,
 * so a flat recipe must cost exactly zero extra round trips.
 */
export const getSubRecipeClosure = async (
  db: Database,
  roots: readonly Pick<RecipeOut, "id" | "sections">[],
): Promise<Record<string, RecipeGraphOut>> => {
  const closure: Record<string, RecipeGraphOut> = {};
  let frontier = collectSubRecipeIds(roots);
  if (frontier.length === 0) return closure;

  return withTrace(
    TraceNames.db("recipe.getSubRecipeClosure"),
    async (span) => {
      const seen = new Set<string>();
      while (frontier.length > 0) {
        const toFetch = frontier.filter((id) => !seen.has(id));
        for (const id of toFetch) seen.add(id);
        if (toFetch.length === 0) break;
        const fetched = await getRecipesByIDs(
          db,
          await resolveAllPresent(db, "recipe", toFetch),
        );
        frontier = [];
        for (const r of fetched) {
          closure[r.id] = r;
          frontier.push(...collectSubRecipeIds([r]));
        }
      }
      span.setAttribute("recipe.subrecipe_count", Object.keys(closure).length);
      return closure;
    },
  );
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
): Promise<
  Array<{
    title: string;
    id: RecipeShortcode;
    entityId: RecipeId;
    sig: string;
  }>
> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
    columns: { id: true, name: true, shortcode: true },
  });
  const recipes = await getRecipesByIDs(
    db,
    rows.map((r) => r.id),
  );
  const byId = new Map(recipes.map((r) => [r.id, r]));
  return rows.flatMap((r) => {
    const full = byId.get(unsafeRecipeShortcode(r.shortcode));
    return full
      ? [
          {
            title: r.name,
            id: unsafeRecipeShortcode(r.shortcode),
            entityId: r.id,
            sig: recipeOutSignature(full),
          },
        ]
      : [];
  });
};

// Normalize a title for cross-recipe reference matching (trim + lowercase).
export const normalizeTitle = (title: string): string =>
  title.trim().toLowerCase();

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
 * Get a recipe by shortcode. Returns null if the code doesn't resolve to a
 * live recipe.
 */
export const getRecipeByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<RecipeOut | null> => {
  const id = await resolveLiveShortcode(db, shortcode, "recipe");
  return id ? getRecipeByID(db, unsafeRecipeId(id)) : null;
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
): Promise<Array<{ id: string; pageId: string; recipe: RecipeGraphOut }>> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(eq(recipe.SourceType, "Notion"), notDeleted(recipe)),
    columns: { id: true, shortcode: true, SourceData: true },
  });
  const recipes = await getRecipesByIDs(
    db,
    rows.map((r) => r.id),
  );
  const byId = new Map(recipes.map((r) => [r.id, r]));
  return rows.flatMap((r) => {
    const full = byId.get(unsafeRecipeShortcode(r.shortcode));
    return r.SourceData && full
      ? [{ id: r.id, pageId: r.SourceData, recipe: full }]
      : [];
  });
};

/**
 * "This recipe has no tags" — the empty state of a nullable `text[]`.
 *
 * Written as one parenthesized raw fragment rather than `or(isNull(...), ...)`
 * so it types as a plain `SQL` (drizzle's `or` is `SQL | undefined`) and so
 * `not()` wraps it correctly. Interpolating a COLUMN is safe here; the
 * row-constructor trap documented at the `arrayOverlaps` call below is about
 * interpolating a JS array.
 */
const TAGS_ARE_EMPTY = sql`(${recipe.tags} IS NULL OR cardinality(${recipe.tags}) = 0)`;

/**
 * List recipes with filters, sorting, and pagination.
 */
export const recipeList = async (
  db: Database,
  filters: RecipeFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
) => {
  const dbClient = getDb(db);

  // Recipes currently used as a sub-recipe: a live recipe-as-ingredient row
  // (`ingredient.recipeId`) reached through a LIVE link — section-ingredient →
  // section → parent recipe, each non-deleted. Matching the "in use" scoping the
  // ingredient usage SQL uses (helpers.ts) matters because removing a sub-recipe
  // line only soft-deletes the link, never the pointer `Ingredient` row: keying
  // off the pointer alone would exclude a recipe from suggestions forever.
  // Deliberately UNCORRELATED (no back-reference to the outer recipe.id): the RQB
  // data query aliases the root table while `countWhere` doesn't, so a correlated
  // EXISTS resolves against different names in each. `isNotNull` is load-bearing —
  // a NULL in a NOT IN list matches no rows at all.
  const parentRecipe = alias(recipe, "parentRecipe");
  const subRecipeIds = dbClient
    .select({ recipeId: ingredient.recipeId })
    .from(ingredient)
    .innerJoin(
      recipeSectionIngredient,
      eq(recipeSectionIngredient.ingredientId, ingredient.id),
    )
    .innerJoin(
      recipeSection,
      eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
    )
    .innerJoin(parentRecipe, eq(parentRecipe.id, recipeSection.recipeId))
    .where(
      and(
        isNotNull(ingredient.recipeId),
        notDeleted(ingredient),
        notDeleted(recipeSectionIngredient),
        notDeleted(recipeSection),
        notDeleted(parentRecipe),
      ),
    );

  // Recipes planned into a live meal. A live MealRecipe under a soft-deleted
  // Meal is not a plan — join-guarded, not just notDeleted(mealRecipe).
  const recipeIdsInLiveMeals = dbClient
    .select({ recipeId: mealRecipe.recipeId })
    .from(mealRecipe)
    .innerJoin(meal, and(eq(meal.id, mealRecipe.mealId), notDeleted(meal)))
    .where(notDeleted(mealRecipe));

  // Recipes with at least one live, non-PDF image — mirrors the product list's
  // `productIdsWithImages` (Image is separately soft-deletable from RecipeImage,
  // and a PDF is a document attachment, not a displayable photo).
  const recipeIdsWithImages = dbClient
    .select({ recipeId: recipeImage.recipeId })
    .from(recipeImage)
    .innerJoin(image, and(eq(image.id, recipeImage.imageId), notDeleted(image)))
    .where(
      and(notDeleted(recipeImage), ne(image.contentType, PDF_CONTENT_TYPE)),
    );

  // Build where conditions - always filter out deleted items. Scope to one
  // cookbook by FK id when browsing its detail page.
  const pickerSearch = filters.nameFilter
    ? or(
        formatSearchTerm(recipe.name, filters.nameFilter),
        formatSearchTerm(recipe.notes, filters.nameFilter),
      )
    : undefined;
  const whereClause = buildSearchConditions(
    recipe,
    [],
    [
      ...auditDateWhereConditions(recipe, filters),
      ...relatedWhereConditions(
        "recipe",
        filters as unknown as Record<string, unknown>,
        recipe.id,
      ),
      pickerSearch,
      eqAnyOrPresence(
        recipe.cookbookId,
        filters.cookbookId,
        filters.cookbookPresenceFilter,
      ),
      // arrayOverlaps, not a hand-rolled `&&`: drizzle interpolates a JS array
      // into raw SQL as a ROW CONSTRUCTOR (`&& ($1, $2)`), which isn't a
      // text[] — the hand-rolled version failed for every tag count, one
      // included. Semantics are unchanged (ANY-of / array overlap).
      //
      // OR-ed with the tag column's presence sentinel, so "quick or untagged"
      // is one filter. `tags` is a nullable array, so untagged means NULL *or*
      // zero-length: clearing a recipe's last tag writes `{}`, not NULL, and
      // keying off IS NULL alone would hide those rows from the very view
      // meant to find them. "has" is `not()` of the same predicate rather than
      // a second hand-written one, so the two can never drift into a gap that
      // hides a recipe from BOTH options.
      or(
        filters.tagFilters && filters.tagFilters.length > 0
          ? arrayOverlaps(recipe.tags, filters.tagFilters)
          : undefined,
        presenceCondition(
          recipe.tags,
          filters.tagsPresenceFilter,
          TAGS_ARE_EMPTY,
        ),
      ),
      filters.excludeSubRecipes
        ? notInArray(recipe.id, subRecipeIds)
        : undefined,
      idSetPresence(
        recipe.id,
        filters.mealPresenceFilter,
        recipeIdsInLiveMeals,
      ),
      idSetPresence(
        recipe.id,
        filters.imagePresenceFilter,
        recipeIdsWithImages,
      ),
      filters.costTotalMin !== undefined
        ? sql`(${recipe.totals}->>'costTotal')::numeric >= ${filters.costTotalMin}`
        : undefined,
      filters.costTotalMax !== undefined
        ? sql`(${recipe.totals}->>'costTotal')::numeric <= ${filters.costTotalMax}`
        : undefined,
      filters.caloriesTotalMin !== undefined
        ? sql`(${recipe.totals}->>'caloriesTotal')::numeric >= ${filters.caloriesTotalMin}`
        : undefined,
      filters.caloriesTotalMax !== undefined
        ? sql`(${recipe.totals}->>'caloriesTotal')::numeric <= ${filters.caloriesTotalMax}`
        : undefined,
    ],
  );

  // Build orderBy using central sortableFields config. Several sortable columns
  // aren't plain scalar columns, so a resolver special-cases them:
  //  - costTotal/caloriesTotal live in the `totals` jsonb
  //  - source = SourceType (groups Book/Website/Notion/Other) then SourceData
  //    (name/url) — both columns are components of the field, so they stay
  //    adjacent at any stack position
  //  - yield = the `servings` integer (yield-only recipes have null servings → last)
  //  - tags = first tag; its old trailing `name asc` was a cosmetic tie-break,
  //    now the single tieBreaker so it can't swallow a stacked secondary sort
  // everything else goes through the generic buildOrderBy column path.
  const resolveRecipeSort = (s: SortParams): SQL[] | null => {
    const isAsc = s.direction === "asc";
    const dir = (col: AnyColumn): SQL =>
      isAsc ? sql`${col} asc nulls last` : sql`${col} desc nulls last`;
    const jsonbSortKey =
      s.orderBy === "costTotal"
        ? "costTotal"
        : s.orderBy === "caloriesTotal"
          ? "caloriesTotal"
          : null;
    if (s.orderBy === "cookbook")
      return [
        sql.raw(
          `(SELECT c."name" FROM "Cookbook" c ` +
            `WHERE c."id" = "recipe"."cookbookId" AND c."deletedAt" IS NULL) ` +
            `${isAsc ? "asc" : "desc"} nulls last`,
        ),
      ];
    if (s.orderBy === "source")
      return [dir(recipe.SourceType), dir(recipe.SourceData)];
    if (s.orderBy === "yield") return [dir(recipe.servings)];
    if (s.orderBy === "tags")
      return [
        isAsc
          ? sql`${recipe.tags}[1] asc nulls last`
          : sql`${recipe.tags}[1] desc nulls last`,
      ];
    if (jsonbSortKey)
      return [
        isAsc
          ? sql`(${recipe.totals}->>${jsonbSortKey})::numeric asc nulls last`
          : sql`(${recipe.totals}->>${jsonbSortKey})::numeric desc nulls last`,
      ];
    return null;
  };
  const orderByClause = buildOrderBy(recipe, sorts, [...recipeSortableFields], {
    resolve: resolveRecipeSort,
    tieBreaker: sql`${recipe.name} asc`,
  });

  const { take, skip } = buildTakeSkip(pagination);

  // Summary fetch: flat recipe rows (no section graph) + persisted totals via dbRecipeToListAPI — the nested graph nobody renders was the ~4.7s over-fetch.
  // `images` is capped to a single (cover) row via recipeListCoverImageRelation
  // — the list only ever renders a thumbnail, never the full gallery.
  // `mealCount` is a scalar extra so the "Meals" column doesn't need a second
  // round trip; same live-join semantics as `recipeIdsInLiveMeals` above (see
  // liveMealCountForRecipeSql's doc comment).
  const { data: results, count: totalCount } = await executeListQueryWithCount(
    dbClient.query.recipe.findMany({
      where: whereClause,
      orderBy: orderByClause,
      limit: take,
      offset: skip,
      with: {
        images: recipeListCoverImageRelation,
      },
      extras: {
        mealCount: sql<number>`${sql.raw(
          liveMealCountForRecipeSql('"recipe"."id"'),
        )}`.as("mealCount"),
      },
    }),
    countWhere(db, recipe, whereClause),
  );

  const items = results.map(dbRecipeToListAPI);
  return { data: items, count: totalCount };
};

// A cookbook the importer is writing into: its FK id plus its name (stamped onto
// each recipe's SourceData). Created up-front by `upsertCookbook` (cookbook repo).
export type CookbookRef = { id: CookbookId; name: string };

/**
 * Create a new recipe, returning only its id. The whole insert (recipe +
 * sections + ingredients + images + audit) runs in one transaction; unlike
 * {@link createRecipe} it skips the heavy {@link getRecipeByID} re-read — callers
 * that only need the id (every upsert path) avoid a wasted full-graph join.
 */
const createRecipeReturningId = async (
  db: Database,
  recipeInput: RecipeCreateInput,
  actor: ActorContext,
  provenance?: RecipeProvenance,
): Promise<UpsertedRecipe> => {
  const sourceColumns = recipeSourceToColumns(
    provenance ?? webProvenance(recipeInput.meta?.url ?? null),
  );
  const { pendingImageIds } = recipeInput;

  return await withTransaction(db, async (tx) => {
    const createdRecipe = await insertWithShortcode(tx, "recipe", {
      name: recipeInput.name,
      ...sourceColumns,
      yield: recipeInput.yield ?? null,
      servings: recipeInput.servings ?? null,
      tags: recipeInput.tags ?? null,
      notes: recipeInput.notes ?? null,
    });
    const createdRecipeId = createdRecipe.id;

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

    await logAuditEntry(tx, actor, {
      entityType: "recipe",
      entityId: createdRecipe.id,
      action: "create",
    });

    return { id: createdRecipeId, shortcode: createdRecipe.shortcode };
  });
};

/**
 * Create a new recipe and return its full {@link RecipeOut}. Thin wrapper over
 * {@link createRecipeReturningId} + a post-commit {@link getRecipeByID} — for
 * callers (the CRUD create endpoint, tests) that need the materialized recipe.
 */
export const createRecipe = async (
  db: Database,
  recipeInput: RecipeCreateInput,
  actor: ActorContext,
  provenance?: RecipeProvenance,
): Promise<RecipeOut> => {
  const { id } = await createRecipeReturningId(
    db,
    recipeInput,
    actor,
    provenance,
  );
  const fullRecipe = await getRecipeByID(db, id);
  if (!fullRecipe) {
    throw createAppError(
      "RECIPE_NOT_FOUND",
      "Failed to retrieve created recipe",
    );
  }
  return fullRecipe;
};

/**
 * Shared upsert core: find an existing recipe with `matchWhere`; if found,
 * refresh its provenance and replace its sections; otherwise create it. The two
 * public upserts differ only in how they identify "the same recipe" and what
 * provenance they stamp.
 */
/**
 * What an upsert/create hands back: the private id AND the public shortcode.
 * The importers link the finished recipe, and a link needs the shortcode.
 */
export type UpsertedRecipe = { id: RecipeId; shortcode: string };

const upsertRecipeMatching = async (
  input: RecipeCreateInput,
  db: Database,
  actor: ActorContext,
  matchWhere: SQL | undefined,
  provenance: RecipeProvenance,
  // The unique index this upsert races on — scopes recovery so an unrelated
  // constraint violation re-throws immediately instead of taking the recovery
  // path (and a spurious re-SELECT) before re-throwing.
  constraint: string,
): Promise<UpsertedRecipe> => {
  // Update an already-matched recipe: refresh provenance + replace sections.
  const updateMatched = (existingId: RecipeId): Promise<UpsertedRecipe> =>
    withTransaction(db, async (tx) => {
      const updatedRecipe = await updateLiveAndReturn(
        tx,
        recipe,
        {
          ...recipeSourceToColumns(provenance),
          // Re-import reflects the source (like sections + notes — a manual edit
          // doesn't survive a re-import). For web/cookbook recipes name is the match
          // key, so this is a no-op; it only bites for Notion, which matches on page
          // id — a renamed page now updates its title instead of keeping the stale
          // one. Safe: Notion names are exempt from Recipe_name_key (identity is the
          // page id via Recipe_notion_page_key), so the rename can't collide.
          name: input.name,
          // Like sections, notes are replaced from the import source on re-import
          // (a manual edit doesn't survive a re-import).
          notes: input.notes ?? null,
          // yield/servings also reflect the source on re-import (every importer
          // carries them, null when unparsed). Previously omitted -> stale forever.
          yield: input.yield ?? null,
          servings: input.servings ?? null,
          // Tags only when the importer actually supplies them (Notion page columns).
          // Web/cookbook imports leave tags undefined, so don't clobber manual tags.
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          updatedAt: new Date(),
        },
        existingId,
      );
      await replaceRecipeSections(tx, updatedRecipe.id, input.sections);
      return { id: updatedRecipe.id, shortcode: updatedRecipe.shortcode };
    });

  const existingRecipe = await getDb(db).query.recipe.findFirst({
    where: matchWhere,
    columns: { id: true, shortcode: true },
  });
  if (existingRecipe) {
    return updateMatched(existingRecipe.id);
  }

  // No match: create. `createRecipe` owns its transaction, so if a concurrent
  // request created the same recipe between our SELECT and this INSERT, its txn
  // aborts on `constraint` and fully rolls back. runWithConflictRecovery then
  // re-SELECTs the committed winner and takes the update path instead of 500ing.
  return runWithConflictRecovery(
    async () => {
      // Only the id is used here — skip the full-graph re-read createRecipe does.
      return await createRecipeReturningId(db, input, actor, provenance);
    },
    async (error) => {
      const winner = await getDb(db).query.recipe.findFirst({
        where: matchWhere,
        columns: { id: true, shortcode: true },
      });
      if (!winner) throw error;
      return updateMatched(winner.id);
    },
    constraint,
  );
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
): Promise<UpsertedRecipe> =>
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
    "Recipe_name_key",
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
): Promise<UpsertedRecipe> =>
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
    "Recipe_book_title_key",
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
): Promise<UpsertedRecipe> =>
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
    "Recipe_notion_page_key",
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

  return await withTransaction(db, async (tx) => {
    await updateRecipeBasicProperties(tx, id, updates, existingRecipe);
    await updateRecipeImages(tx, id, updates);

    if (updates.sections) {
      await handleSectionUpdates(tx, id, updates.sections, existingRecipe);
    }

    const fullRecipe = await getRecipeByID(tx, id);
    if (!fullRecipe) {
      throw createAppError(
        "RECIPE_NOT_FOUND",
        "Failed to retrieve updated recipe",
      );
    }

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
 * Tx-scoped body of {@link deleteRecipes}. Split out so a caller that owns a
 * wider transaction (the cookbook delete, which removes the book row in the same
 * txn) shares the exact cascade, embedding cleanup, and audit trail.
 */
const deleteRecipesTx = async (
  tx: DrizzleTransaction,
  ids: RecipeId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  // Lock recipes and validate they exist and aren't already deleted
  // Prevents race conditions by acquiring row-level locks
  await lockAndValidateForDelete(tx, recipe, ids, "Recipe");

  const now = new Date();

  // Get all sections for these recipes
  const sections = await tx.query.recipeSection.findMany({
    where: and(inArray(recipeSection.recipeId, ids), notDeleted(recipeSection)),
    columns: { id: true, recipeId: true },
  });

  const sectionIds = sections.map((s) => s.id);

  // Get counts of cascaded items (per recipe) for the audit trail.
  const cascadedImages = await tx.query.recipeImage.findMany({
    where: and(inArray(recipeImage.recipeId, ids), notDeleted(recipeImage)),
    columns: { recipeId: true },
  });

  // Meal-plan membership. This is a cascade, not a guard, for two reasons: the
  // removal-path invariant says a delete cleans up its dependents in the same
  // transaction, and a guard here would make deleteCookbook's unconditional
  // recipe cascade throw mid-transaction. Without this the MealRecipe row
  // outlives its recipe and the meal keeps counting it.
  //
  // The other incoming edge, `ingredient.recipeId` (the sub-recipe pointer), is
  // deliberately NOT touched: the router resolves parents and calls
  // dispatchRecompute, with findParentRecipesWithDeletedSubRecipes as the
  // backstop detector. Cascading or guarding it would break sub-recipe deletion.
  const cascadedMealRecipes = await tx.query.mealRecipe.findMany({
    where: and(inArray(mealRecipe.recipeId, ids), notDeleted(mealRecipe)),
    columns: { recipeId: true },
  });

  let cascadedIngredients: Array<{ recipeSectionId: string }> = [];
  if (sectionIds.length > 0) {
    cascadedIngredients = await tx.query.recipeSectionIngredient.findMany({
      where: and(
        inArray(recipeSectionIngredient.recipeSectionId, sectionIds),
        notDeleted(recipeSectionIngredient),
      ),
      columns: { recipeSectionId: true },
    });
  }

  // Ingredients are counted via their section's recipe (no direct recipeId).
  const sectionToRecipe = new Map(sections.map((s) => [s.id, s.recipeId]));
  const sectionsByRecipe = countBy(sections, (s) => s.recipeId);
  const imagesByRecipe = countBy(cascadedImages, (i) => i.recipeId);
  const mealRecipesByRecipe = countBy(cascadedMealRecipes, (mr) => mr.recipeId);
  const ingredientsByRecipe = countBy(
    cascadedIngredients
      .map((ing) => sectionToRecipe.get(ing.recipeSectionId))
      .filter((id): id is RecipeId => id != null),
    (id) => id,
  );

  // Soft delete recipe section ingredients
  if (sectionIds.length > 0) {
    await tx
      .update(recipeSectionIngredient)
      .set({ deletedAt: now })
      .where(
        and(
          inArray(recipeSectionIngredient.recipeSectionId, sectionIds),
          notDeleted(recipeSectionIngredient),
        ),
      );
  }

  // Soft delete recipe sections
  await tx
    .update(recipeSection)
    .set({ deletedAt: now })
    .where(
      and(inArray(recipeSection.recipeId, ids), notDeleted(recipeSection)),
    );

  // Soft delete recipe images
  await tx
    .update(recipeImage)
    .set({ deletedAt: now })
    .where(and(inArray(recipeImage.recipeId, ids), notDeleted(recipeImage)));

  // Soft delete meal-plan memberships
  await tx
    .update(mealRecipe)
    .set({ deletedAt: now })
    .where(and(inArray(mealRecipe.recipeId, ids), notDeleted(mealRecipe)));

  // Soft delete recipes
  await tx
    .update(recipe)
    .set({ deletedAt: now })
    .where(and(inArray(recipe.id, ids), notDeleted(recipe)));

  // Cascade the search embedding so a direct repo delete (no mutation
  // side-effect) can't leave an orphaned entityEmbedding row.
  await softDeleteEntityEmbeddingsTx(tx, "recipe", ids);

  const auditEntries = buildCascadeAuditEntries("recipe", ids, {
    cascadedSections: sectionsByRecipe,
    cascadedIngredients: ingredientsByRecipe,
    cascadedImages: imagesByRecipe,
    cascadedMealRecipes: mealRecipesByRecipe,
  });

  await logAuditEntries(tx, actor, auditEntries);
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

  await withTransaction(db, (tx) => deleteRecipesTx(tx, ids, actor));
};

/**
 * Soft-delete every non-deleted recipe linked to a cookbook, inside the caller's
 * transaction — the cookbook repo removes the `Cookbook` row in the same txn, so
 * a book can't survive its recipes. Shares the section/ingredient/image cascade,
 * embedding cleanup, and audit trail with {@link deleteRecipes}; returns the
 * deleted ids so the caller can run mutation side-effects.
 */
export const deleteRecipesByCookbookTx = async (
  tx: DrizzleTransaction,
  cookbookId: CookbookId,
  actor: ActorContext,
): Promise<RecipeId[]> => {
  const rows = await tx.query.recipe.findMany({
    where: and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
    columns: { id: true, shortcode: true },
  });
  const ids = rows.map((r) => r.id);
  await deleteRecipesTx(tx, ids, actor);
  return ids;
};

/**
 * Recompute-worthy parents of the given (about-to-be-deleted) recipes,
 * reshaped for {@link previewDeleteRecipes}' "parent recipes recomputed" side
 * effect: which of `ids` has surviving parents, and the deduped id set of
 * those parents.
 *
 * This mirrors — without literally sharing code with, since that logic lives
 * outside this file's ownership for this change — the
 * `uniq([...parentsByRecipe.values()].flat().filter((id) => !deletedSet.has(id)))`
 * step both `deleteItem` (`api/routers/recipe/crud.ts`) and
 * `deleteCookbookEndpoint` (`api/routers/recipe/import.ts`) run on
 * {@link findParentRecipeIdsBatch}'s result before calling
 * `dispatchRecompute`. Preview and mutation both read off the SAME
 * `findParentRecipeIdsBatch` query, so they cannot disagree about WHICH rows
 * are parents — only this reshaping (per-sub-recipe breakdown vs. a flat
 * dispatch list) differs, and only because the router owns the dispatch call
 * and this file cannot import from it.
 */
const resolveRecomputeParents = async (
  db: Database,
  ids: RecipeId[],
): Promise<{ parentIds: RecipeId[]; byTargetId: Record<string, number> }> => {
  const deletedSet = new Set(ids);
  const parentsBySubRecipe = await findParentRecipeIdsBatch(db, ids);
  const byTargetId: Record<string, number> = {};
  const allParents = new Set<RecipeId>();
  for (const [subRecipeId, parents] of parentsBySubRecipe) {
    // A sub-recipe deleted alongside its own parent (both selected in the
    // same bulk delete) has nothing left to recompute — excluded the same
    // way the router excludes it before dispatching.
    const survivingParents = uniq(parents.filter((id) => !deletedSet.has(id)));
    if (survivingParents.length === 0) continue;
    byTargetId[subRecipeId] = survivingParents.length;
    for (const parentId of survivingParents) allParents.add(parentId);
  }
  return { parentIds: [...allParents], byTargetId };
};

/**
 * What {@link deleteRecipes} would do to the given recipes, without doing it.
 *
 * Reads the SAME `RECIPE_DELETE_EDGE_POLICY` `deleteRecipesTx` is described
 * by. The policy has no `block`-effect edge — a recipe delete never refuses on
 * an incoming edge, unlike `previewDeleteProducts` — so `blockers` is always
 * empty here.
 *
 * `RecipeSection.recipeId` / `MealRecipe.recipeId` / `RecipeImage.recipeId`
 * cascade (`soft-delete`) and become `changes`, counted with the identical
 * `inArray(column, ids) AND notDeleted(table)` predicate `deleteRecipesTx`
 * fetches its `cascadedX` rows with (via {@link countByTarget}). Two things
 * that are NOT row cascades become `sideEffects`: `Ingredient.recipeId`'s
 * `preserve` disposition (the sub-recipe pointer deliberately left untouched —
 * see `deleteRecipesTx`'s comment on `cascadedMealRecipes`), and the
 * parent-recipe recomputes that pointer triggers (see
 * {@link resolveRecomputeParents}).
 *
 * Advisory only. `deleteRecipes` still re-runs its own cascade inside its own
 * transaction; nothing here is a lock or a permission.
 */
export const previewDeleteRecipes = async (
  db: Database,
  ids: RecipeId[],
): Promise<{
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects: ImpactItem[];
}> => {
  if (ids.length === 0) return { blockers: [], changes: [], sideEffects: [] };

  const dbClient = getDb(db);

  const cascades: Array<[string, PgTable, PgColumn, string]> = [
    [
      "RecipeSection.recipeId",
      recipeSection,
      recipeSection.recipeId,
      "sections",
    ],
    [
      "MealRecipe.recipeId",
      mealRecipe,
      mealRecipe.recipeId,
      "meal-plan associations",
    ],
    ["RecipeImage.recipeId", recipeImage, recipeImage.recipeId, "images"],
  ];

  const changes: (ImpactItem | null)[] = [];
  for (const [edgeKey, table, column, label] of cascades) {
    const disposition =
      RECIPE_DELETE_EDGE_POLICY[
        edgeKey as keyof typeof RECIPE_DELETE_EDGE_POLICY
      ];
    changes.push(
      impact({
        disposition,
        edgeKey,
        label,
        byTargetId: await countByTarget(dbClient, table, column, ids),
      }),
    );
  }

  const sideEffects: ImpactItem[] = [];

  const preserveDisposition = RECIPE_DELETE_EDGE_POLICY["Ingredient.recipeId"];
  const preservedByTargetId = await countByTarget(
    dbClient,
    ingredient,
    ingredient.recipeId,
    ids,
  );
  const preservedTotal = sum(Object.values(preservedByTargetId));
  if (preservedTotal > 0) {
    sideEffects.push(
      sideEffect({
        code: preserveDisposition.code,
        label: "sub-recipe pointers preserved",
        description: preserveDisposition.description,
        effect: preserveDisposition.effect,
        total: preservedTotal,
        byTargetId: preservedByTargetId,
      }),
    );
  }

  const { parentIds, byTargetId: parentsByTargetId } =
    await resolveRecomputeParents(db, ids);
  if (parentIds.length > 0) {
    sideEffects.push(
      sideEffect({
        code: "recompute-parent-recipes",
        label: "parent recipes recomputed",
        description:
          "Recipes that use a deleted recipe as a sub-recipe have their persisted cost and nutrition totals recomputed.",
        total: parentIds.length,
        byTargetId: parentsByTargetId,
      }),
    );
  }

  return {
    blockers: [],
    changes: present(changes),
    sideEffects,
  };
};
