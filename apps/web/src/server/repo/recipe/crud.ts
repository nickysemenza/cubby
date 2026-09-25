import type { ActorContext } from "@cubby/schemas/context";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { OperationDisposition } from "@cubby/schemas/entity-integrity";
import {
  type CookbookId,
  type ImageShortcode,
  parseEntityId,
  parseShortcodeFor,
  type RecipeId,
  type RecipeShortcode,
} from "@cubby/schemas/identifiers";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import type {
  RecipeCreateInput,
  RecipeGraphOut,
  RecipeOut,
  RecipeUpdateInput,
} from "@cubby/schemas/recipe";
import {
  type AnyColumn,
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { countBy } from "es-toolkit";
import { match, P } from "ts-pattern";

import { collectSubRecipeIds } from "~/lib/recipe-graph";
import { recipeOutSignature } from "~/lib/recipe-signature";
import type { Database, DrizzleTransaction } from "~/server/db";
import type { IncomingEdgePolicy } from "~/server/db/entity-incoming-edges";
import {
  entityAttachment,
  image,
  ingredient,
  meal,
  mealRecipe,
  mealRecipePortion,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { runWithConflictRecovery } from "~/server/errors/db-errors";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import { loadDataQualities } from "~/server/repo/data-quality";
import {
  associatePendingImages,
  eqAnyRequested,
  getDb,
  idSetPresence,
  imageCascadeChild,
  imageJoinBindings,
  type ListReadIntent,
  lockAndValidateForDelete,
  notDeleted,
  presenceCondition,
  rangeConditions,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
  withTransactionOn,
} from "~/server/repo/database-helpers";
import { resolveEntityDisplayImages } from "~/server/repo/entity-display-image";
import { recipeHasImages } from "~/server/repo/image";
import { displayableImageWhere } from "~/server/repo/image-displayability";
import { listScaffold } from "~/server/repo/list-scaffold";
import { relatedWhereConditions } from "~/server/repo/related-view";
import { removeEntity } from "~/server/repo/removal";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveFilterIds,
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { TraceNames, withTrace } from "~/server/tracing";
import { getR2PublicUrl } from "~/server/utils/r2-public-url";

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
  "EntityAttachment.subjectEntityId": {
    code: "soft-delete-association",
    effect: "soft-delete",
    description:
      "Image associations are soft-deleted with the recipe, and each file is\n      deleted too unless something else still references it.",
  },
  "Recipe.forkedFromRecipeId": {
    code: "clear-fork-pointer",
    effect: "detach",
    description:
      "A deleted recipe's forks have their forkedFromRecipeId pointer nulled out — a fork is a full independent recipe, so it survives its parent's deletion, just without the lineage pointer.",
  },
} as const satisfies IncomingEdgePolicy<"recipe", OperationDisposition>;

import { withDisplayImages } from "~/server/repo/entity-display-image";

import {
  dbRecipeToAPI,
  dbRecipeToAPIGraph,
  dbRecipeToListAPI,
  liveMealCountForRecipeSql,
  liveSectionCountForRecipeSql,
} from "./helpers";
import type { RecipeFilters } from "./internal-types";
import { recipeMetaToColumns } from "./meta";
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

export const getRecipeByID = async (
  db: Database | DrizzleTransaction,
  id: RecipeId,
): Promise<RecipeOut | null> => {
  const res = await unwrapDb(db).query.recipe.findFirst({
    where: and(eq(recipe.id, id), notDeleted(recipe)),
    ...relations.recipe.full,
  });
  if (res === null || res === undefined) return null;
  const qualities = await loadDataQualities(db, "recipe", [res.id]);
  // SAFETY: `res` was just fetched live by id, so its quality was evaluated.
  return dbRecipeToAPI(res, qualities.get(res.id)!);
};

export const getRecipeCoverImageUrlsByShortcodes = async (
  db: Database,
  ids: RecipeShortcode[],
): Promise<Map<RecipeShortcode, string>> => {
  const byId = new Map<RecipeShortcode, string>();
  if (ids.length === 0) return byId;

  const rows = await getDb(db)
    .select({ shortcode: recipe.shortcode, key: image.key })
    .from(recipe)
    .innerJoin(
      entityAttachment,
      eq(entityAttachment.subjectEntityId, recipe.id),
    )
    .innerJoin(image, eq(image.id, entityAttachment.imageId))
    .where(
      and(
        inArray(recipe.shortcode, ids),
        notDeleted(recipe),
        notDeleted(entityAttachment),
        notDeleted(image),
        displayableImageWhere,
      ),
    )
    .orderBy(
      recipe.shortcode,
      asc(entityAttachment.sortOrder),
      asc(entityAttachment.createdAt),
      asc(entityAttachment.id),
    );

  for (const row of rows) {
    const shortcode = parseShortcodeFor("recipe", row.shortcode);
    if (!byId.has(shortcode)) byId.set(shortcode, getR2PublicUrl(row.key));
  }
  return byId;
};

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
    const displayImages = await resolveEntityDisplayImages(
      db,
      rows.map((row) => ({ entityType: "recipe", entityId: row.id })),
    );
    return rows.map((row) => ({
      ...dbRecipeToAPIGraph(row),
      displayImage: displayImages.get(entityRefKey("recipe", row.id)) ?? null,
    }));
  });
};

/** Sub-recipe closure shared by costing and needs expansion. */
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

export const getCookbookRecipesForDiff = async (
  db: Database,
  cookbookId: CookbookId,
): Promise<
  Array<{
    title: string;
    id: RecipeShortcode;
    entityId: RecipeId;
    sig: string;
    hasImage: boolean;
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
  const hasImageById = new Map(
    await Promise.all(
      rows.map(
        async (row) => [row.id, await recipeHasImages(db, row.id)] as const,
      ),
    ),
  );
  return rows.flatMap((r) => {
    const full = byId.get(parseShortcodeFor("recipe", r.shortcode));
    return full
      ? [
          {
            title: r.name,
            id: parseShortcodeFor("recipe", r.shortcode),
            entityId: r.id,
            sig: recipeOutSignature(full),
            hasImage: hasImageById.get(r.id) ?? false,
          },
        ]
      : [];
  });
};

export const normalizeTitle = (title: string): string =>
  title.trim().toLowerCase();

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

export const getRecipeByShortcode = async (
  db: Database,
  shortcode: string,
): Promise<RecipeOut | null> => {
  const id = await resolveLiveShortcode(db, shortcode, "recipe");
  return id ? getRecipeByID(db, parseEntityId("recipe", id)) : null;
};

export const getNotionRecipePageIds = async (
  db: Database,
): Promise<string[]> => {
  const rows = await getDb(db).query.recipe.findMany({
    where: and(eq(recipe.SourceType, "Notion"), notDeleted(recipe)),
    columns: { SourceData: true },
  });
  return rows.map((r) => r.SourceData).filter((s): s is string => s !== null);
};

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
    const full = byId.get(parseShortcodeFor("recipe", r.shortcode));
    return r.SourceData && full
      ? [{ id: r.id, pageId: r.SourceData, recipe: full }]
      : [];
  });
};

/** A nullable tag array is empty when null or zero-length. */

const recipeScaffold = listScaffold("recipe", recipe);

/** The complete WHERE for this entity's list. `getEntityCounts` calls it with `{}` — see repo/dashboard.ts. */
export const buildRecipeWhere = async (
  db: Database,
  filters: RecipeFilters,
) => {
  const dbClient = getDb(db);
  const cookbookIds = await resolveFilterIds(
    db,
    "cookbook",
    filters.cookbookId,
  );

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

  // PDFs are documents, not displayable recipe images.
  const recipeIdsWithImages = dbClient
    .select({ recipeId: entityAttachment.subjectEntityId })
    .from(entityAttachment)
    .innerJoin(
      image,
      and(eq(image.id, entityAttachment.imageId), notDeleted(image)),
    )
    .where(
      and(
        notDeleted(entityAttachment),
        ne(image.contentType, PDF_CONTENT_TYPE),
      ),
    );

  const recipeIdsWithInstructions = dbClient
    .select({ recipeId: recipeSection.recipeId })
    .from(recipeSection)
    .where(
      and(
        notDeleted(recipeSection),
        sql`jsonb_array_length(${recipeSection.instructions}) > 0`,
      ),
    );

  const sourceTypes =
    filters.sourceTypeFilter === undefined
      ? undefined
      : [filters.sourceTypeFilter].flat();

  // `nameFilter` (name ∪ notes), `tagFilters` (an overlap over the nullable
  // `tags` array, ORed with `tagsPresenceFilter`) and `totalMinutes` are
  // declared stored filters — applied by `recipeScaffold.where` before the
  // conditions below.
  return recipeScaffold.where(filters, [
    ...relatedWhereConditions("recipe", filters, recipe.id),
    // `eqAnyRequested` + `presenceCondition` rather than `eqAnyOrPresence`:
    // the id half must distinguish "no cookbook filter" (unrestricted) from
    // "a cookbook code that resolves to nothing" (match nothing), which the
    // combined helper's `eqAny` cannot. The OR against the presence sentinel
    // is unchanged — presence WIDENS the id filter (see `tagsPresenceFilter`).
    or(
      eqAnyRequested(recipe.cookbookId, cookbookIds),
      presenceCondition(recipe.cookbookId, filters.cookbookPresenceFilter),
    ),
    filters.excludeSubRecipes ? notInArray(recipe.id, subRecipeIds) : undefined,
    idSetPresence(recipe.id, filters.mealPresenceFilter, recipeIdsInLiveMeals),
    idSetPresence(recipe.id, filters.imagePresenceFilter, recipeIdsWithImages),
    idSetPresence(
      recipe.id,
      filters.instructionsPresenceFilter,
      recipeIdsWithInstructions,
    ),
    // Presence widens this filter; null is a valid legacy manual source.
    or(
      eqAnyRequested(recipe.SourceType, sourceTypes),
      presenceCondition(recipe.SourceType, filters.sourceTypePresenceFilter),
    ),
    ...rangeConditions(
      sql`CASE WHEN ${recipe.totalsComputedAt} IS NOT NULL THEN (${recipe.totals} #>> '{cost,lower}')::numeric END`,
      filters,
      "costTotal",
    ),
    ...rangeConditions(
      sql`CASE WHEN ${recipe.totalsComputedAt} IS NOT NULL THEN (${recipe.totals} #>> '{nutrition,kcal,lower}')::numeric END`,
      filters,
      "caloriesTotal",
    ),
  ]);
};

export const recipeList = async (
  db: Database,
  filters: RecipeFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  readIntent: ListReadIntent = "page",
) => {
  const resolveRecipeSort = (s: SortParams): SQL[] | null => {
    const isAsc = s.direction === "asc";
    const dir = (col: AnyColumn): SQL =>
      isAsc ? sql`${col} asc nulls last` : sql`${col} desc nulls last`;
    const totalsSortValue =
      s.orderBy === "costTotal"
        ? sql`(${recipe.totals} #>> '{cost,lower}')::numeric`
        : s.orderBy === "caloriesTotal"
          ? sql`(${recipe.totals} #>> '{nutrition,kcal,lower}')::numeric`
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
    if (s.orderBy === "servings") return [dir(recipe.servings)];
    if (s.orderBy === "tags")
      return [
        isAsc
          ? sql`${recipe.tags}[1] asc nulls last`
          : sql`${recipe.tags}[1] desc nulls last`,
      ];
    if (totalsSortValue)
      return [
        isAsc
          ? sql`CASE WHEN ${recipe.totalsComputedAt} IS NOT NULL THEN ${totalsSortValue} END asc nulls last`
          : sql`CASE WHEN ${recipe.totalsComputedAt} IS NOT NULL THEN ${totalsSortValue} END desc nulls last`,
      ];
    return null;
  };
  return recipeScaffold.list(
    db,
    { filters, sorts, pagination, readIntent },
    {
      where: await buildRecipeWhere(db, filters),
      resolveSort: resolveRecipeSort,
      tieBreaker: sql`${recipe.name} asc`,
      // List reads fetch flat rows and scalar counts; never full graphs. The
      // thumbnail comes from the display-image resolver, not an images join.
      select: (page) =>
        getDb(db).query.recipe.findMany({
          ...page,
          extras: {
            mealCount: sql<number>`${sql.raw(
              liveMealCountForRecipeSql('"recipe"."id"'),
            )}`.as("mealCount"),
            sectionCount: sql<number>`${sql.raw(
              liveSectionCountForRecipeSql('"recipe"."id"'),
            )}`.as("sectionCount"),
          },
        }),
      hydrate: async (rows) => {
        const qualities = await loadDataQualities(
          db,
          "recipe",
          rows.map((row) => row.id),
        );
        return withDisplayImages(db, "recipe", rows, (row, displayImages) =>
          // SAFETY: `row` came from `rows`, which `qualities` was loaded for.
          dbRecipeToListAPI(row, displayImages, qualities.get(row.id)!),
        );
      },
    },
  );
};

export type CookbookRef = { id: CookbookId; name: string };

/** Graph, images, callback, and audit all run in one transaction. */
const createRecipeReturningId = async (
  db: Database,
  recipeInput: RecipeCreateInput,
  actor: ActorContext,
  provenance?: RecipeProvenance,
  withinTransaction?: (
    tx: DrizzleTransaction,
    createdRecipeId: RecipeId,
  ) => Promise<void>,
): Promise<UpsertedRecipe> => {
  const sourceColumns = recipeSourceToColumns(
    provenance ?? webProvenance(recipeInput.meta?.url ?? null),
  );
  const { pendingImageIds } = recipeInput;

  return await withTransaction(db, async (tx) => {
    const forkedFromRecipeId = recipeInput.forkedFromRecipeId
      ? await resolveOrThrow(tx, "recipe", recipeInput.forkedFromRecipeId)
      : null;

    const createdRecipe = await insertWithShortcode(tx, "recipe", {
      name: recipeInput.name,
      ...sourceColumns,
      yield: recipeInput.yield ?? null,
      servings: recipeInput.servings ?? null,
      tags: recipeInput.tags ?? null,
      notes: recipeInput.notes ?? null,
      forkedFromRecipeId,
      ...recipeMetaToColumns(recipeInput.meta),
    });
    const createdRecipeId = createdRecipe.id;

    for (const [i, section] of recipeInput.sections.entries()) {
      await createSectionWithIngredients(tx, createdRecipeId, section, i);
    }

    // Associate images if provided. `pendingImageIds` arrives as public
    // `IMG-` shortcodes (what `create_file_uploads`/`image.uploadImage` hand
    // back), resolved to uuids here since `associatePendingImages` writes
    // straight into `RecipeImage.imageId`, an unbranded uuid FK. A code that
    // doesn't resolve is dropped rather than thrown on.
    if (pendingImageIds && pendingImageIds.length > 0) {
      const resolvedImageIds = await resolveAllPresent(
        tx,
        "image",
        pendingImageIds,
      );
      await associatePendingImages(
        tx,
        imageJoinBindings.recipe,
        createdRecipe.id,
        resolvedImageIds,
      );
    }

    if (withinTransaction) {
      await withinTransaction(tx, createdRecipeId);
    }

    await logAuditEntry(tx, actor, {
      entityType: "recipe",
      entityId: createdRecipe.id,
      action: "create",
    });

    return { id: createdRecipeId, shortcode: createdRecipe.shortcode };
  });
};

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
 * Provenance for a recipe duplicate, derived from the source's strong
 * `RecipeOut.source` union — NOT re-derived from `meta.url`, which is null for
 * anything but a Website recipe (see `dbRecipeToTopLevelShape`). Using
 * `webProvenance(meta.url)` unconditionally silently coerced every duplicate to
 * `SourceType: 'Website'`, dropping `cookbookId` for Book recipes — 94% of live
 * recipes on production.
 *
 * Book and Website provenance carry straight through: a duplicate's name always
 * gets " (copy)" appended, so it can't collide with `Recipe_book_title_key`
 * (unique on `name, SourceData` where SourceType='Book') or `Recipe_name_key`
 * (unique on `name` alone, for Website/Other).
 *
 * Notion is the one case that can't carry through. `Recipe_notion_page_key` is
 * unique on `SourceData` ALONE (no name component) wherever SourceType='Notion'
 * — a Notion page id identifies exactly one live recipe, the row
 * `upsertNotionRecipe` re-imports into on every sync. Reusing the source's page
 * id on the duplicate would violate that index outright; the alternative isn't
 * better, since it would hand two rows the same "this IS page X" identity, and
 * the next sync could then land on either one nondeterministically. So a Notion
 * duplicate deliberately drops to a plain, unsynced "Other" copy rather than
 * risk either.
 */
const duplicateProvenance = async (
  db: Database,
  source: RecipeOut,
): Promise<RecipeProvenance> => {
  const src = source.source;
  const otherProvenance: RecipeProvenance = {
    sourceType: "Other",
    sourceData: null,
  };
  const cookbookId =
    src?.type === "book" && src.cookbookId
      ? await resolveOrThrow(db, "cookbook", src.cookbookId)
      : null;

  return match(src)
    .with({ type: "book" }, (book): RecipeProvenance => ({
      sourceType: "Book",
      sourceData: book.book,
      cookbookId,
      cookbookShortcode: book.cookbookId ?? null,
    }))
    .with({ type: "website" }, (website): RecipeProvenance => ({
      sourceType: "Website",
      sourceData: website.url,
    }))
    .with({ type: "notion" }, () => otherProvenance)
    .with({ type: "other" }, () => otherProvenance)
    .with(P.nullish, () => otherProvenance)
    .exhaustive();
};

export const duplicateRecipe = async (
  db: Database,
  id: RecipeId,
  actor: ActorContext,
): Promise<RecipeOut> => {
  const source = await getRecipeByID(db, id);
  if (!source) {
    throw createAppError("RECIPE_NOT_FOUND", `Recipe with ID ${id} not found`);
  }

  const provenance = await duplicateProvenance(db, source);

  const input: RecipeCreateInput = {
    name: `${source.name} (copy)`,
    meta: source.meta,
    yield: source.yield,
    servings: source.servings,
    tags: source.tags,
    notes: source.notes,
    sections: source.sections.map((section) => ({
      name: section.name,
      instructions: section.instructions.map((inst) => ({
        instruction: inst.instruction,
      })),
      ingredients: section.ingredients.map((ing) =>
        ing.type === "ingredient"
          ? {
              type: "ingredient" as const,
              ingredientId: ing.ingredient.id,
              recipeId: null,
              amounts: ing.amounts,
              rawLine: ing.rawLine,
              modifier: ing.modifier,
            }
          : {
              type: "recipe" as const,
              recipeId: ing.recipe.id,
              ingredientId: null,
              amounts: ing.amounts,
              rawLine: ing.rawLine,
              modifier: ing.modifier,
            },
      ),
    })),
  };

  const { id: newRecipeId } = await createRecipeReturningId(
    db,
    input,
    actor,
    provenance,
    async (tx, createdRecipeId) => {
      // RecipeImage is a plain (recipeId, imageId) join table, so cloning it
      // means inserting new join rows that point at the SAME Image row — no R2
      // copy, no new Image row. Two recipes sharing an Image row is expected
      // and harmless: Image lifetime is governed by its own reference count
      // (how many join rows still point at it), not by recipe ownership.
      //
      // `source.images[].id` are public `IMG-` shortcodes (`getRecipeByID`'s
      // own output) — resolved back to uuids here since `RecipeImage.imageId`
      // is the FK. A miss would mean an image `source` just read moments ago
      // vanished mid-duplicate, so this throws rather than silently cloning a
      // shorter image list.
      if (source.images.length > 0) {
        const imageIds = await resolveAllOrThrow(
          tx,
          "image",
          source.images.map((img) => img.id),
        );
        await tx.insert(entityAttachment).values(
          imageIds.map((imageId, i) => ({
            subjectEntityId: createdRecipeId,
            role: "attachment" as const,
            imageId,
            sortOrder: i,
          })),
        );
      }
    },
  );

  const duplicated = await getRecipeByID(db, newRecipeId);
  if (!duplicated) {
    throw createAppError(
      "RECIPE_NOT_FOUND",
      "Failed to retrieve duplicated recipe",
    );
  }
  return duplicated;
};

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
  const updateMatched = (existingId: RecipeId): Promise<UpsertedRecipe> =>
    withTransaction(db, async (tx) => {
      // Re-import reflects source-owned fields, while absent imported tags
      // deliberately preserve manual tags.
      const recipeUpdates: Partial<typeof recipe.$inferInsert> = {
        ...recipeSourceToColumns(provenance),
        name: input.name,
        notes: input.notes ?? null,
        yield: input.yield ?? null,
        servings: input.servings ?? null,
        ...recipeMetaToColumns(input.meta),
        updatedAt: new Date(),
      };
      if (input.tags !== undefined) recipeUpdates.tags = input.tags;
      const updatedRecipe = await updateLiveAndReturn(
        tx,
        recipe,
        recipeUpdates,
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

/** Cookbook recipes are excluded because their identity is `(cookbookId, title)`. */
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

/** Notion identity is page ID, so title changes update the same row. */
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

export const updateRecipe = async (
  db: Database,
  id: RecipeId,
  updates: RecipeUpdateInput["data"],
  actor: ActorContext,
): Promise<{ recipe: RecipeOut; detachedImageKeys: string[] }> => {
  let detachedImageKeys: string[] = [];
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

  // `forkedFromRecipeId` is diffed as a raw uuid, like every other FK in an
  // audit roster (e.g. Task.parentTaskId) — not resolved to a shortcode.
  const beforeState = {
    name: existingRecipe.name,
    forkedFromRecipeId: existingRecipe.forkedFromRecipeId,
  };

  const updatedRecipe = await withTransaction(db, async (tx) => {
    const propertyUpdates = await updateRecipeBasicProperties(
      tx,
      id,
      updates,
      existingRecipe,
    );
    detachedImageKeys = await updateRecipeImages(tx, id, updates);

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

    const afterState = {
      name: fullRecipe.name,
      forkedFromRecipeId:
        propertyUpdates.forkedFromRecipeId !== undefined
          ? propertyUpdates.forkedFromRecipeId
          : existingRecipe.forkedFromRecipeId,
    };
    const changes = computeChanges(beforeState, afterState, [
      ...entityFieldModels.recipe.audit,
    ]);
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
  return { recipe: updatedRecipe, detachedImageKeys };
};

/**
 * Soft-deletes the recipe graph in the caller's transaction when provided.
 * Returned R2 keys must not be dropped until that outer transaction commits.
 */
export const deleteRecipes = async (
  dbOrTx: Database | DrizzleTransaction,
  ids: RecipeId[],
  actor: ActorContext,
): Promise<{
  detachedImageKeys: string[];
  deletedImageShortcodes: ImageShortcode[];
  deleted: number;
}> => {
  if (ids.length === 0)
    return { detachedImageKeys: [], deletedImageShortcodes: [], deleted: 0 };

  return await withTransactionOn(dbOrTx, async (tx) => {
    // Lock live rows before cascading so concurrent deletes cannot interleave.
    await lockAndValidateForDelete(tx, recipe, ids, "Recipe");

    const now = new Date();

    const sections = await tx.query.recipeSection.findMany({
      where: and(
        inArray(recipeSection.recipeId, ids),
        notDeleted(recipeSection),
      ),
      columns: { id: true, recipeId: true },
    });

    const sectionIds = sections.map((s) => s.id);

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
    const cascadedMealRecipes = await tx
      .select({ id: mealRecipe.id, recipeId: mealRecipe.recipeId })
      .from(mealRecipe)
      .where(and(inArray(mealRecipe.recipeId, ids), notDeleted(mealRecipe)))
      .orderBy(mealRecipe.id)
      .for("update");
    const cascadedMealRecipeIds = cascadedMealRecipes.map((row) => row.id);

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

    const sectionToRecipe = new Map(sections.map((s) => [s.id, s.recipeId]));
    const sectionsByRecipe = countBy(sections, (s) => s.recipeId);
    const mealRecipesByRecipe = countBy(
      cascadedMealRecipes,
      (mr) => mr.recipeId,
    );
    const ingredientsByRecipe = countBy(
      cascadedIngredients
        .map((ing) => sectionToRecipe.get(ing.recipeSectionId))
        .filter((id): id is RecipeId => id != null),
      (id) => id,
    );

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

    await tx
      .update(recipeSection)
      .set({ deletedAt: now })
      .where(
        and(inArray(recipeSection.recipeId, ids), notDeleted(recipeSection)),
      );

    // Fork lineage is a pointer only ("Recipe.forkedFromRecipeId" in
    // RECIPE_DELETE_EDGE_POLICY, effect "detach"): a fork is a full,
    // independent recipe, so deleting the recipe it was forked from clears
    // the pointer rather than cascading to the fork itself.
    await tx
      .update(recipe)
      .set({ forkedFromRecipeId: null })
      .where(and(inArray(recipe.forkedFromRecipeId, ids), notDeleted(recipe)));

    await tx
      .update(mealRecipe)
      .set({ deletedAt: now })
      .where(and(inArray(mealRecipe.recipeId, ids), notDeleted(mealRecipe)));
    if (cascadedMealRecipeIds.length > 0)
      await tx
        .update(mealRecipePortion)
        .set({ deletedAt: now })
        .where(
          and(
            inArray(mealRecipePortion.mealRecipeId, cascadedMealRecipeIds),
            notDeleted(mealRecipePortion),
          ),
        );

    // Declaring entityAttachment lets removeEntity reap unreferenced Image/R2 rows.
    return await removeEntity(tx, {
      entity: "recipe",
      ids,
      removal: "soft",
      actor,
      children: [imageCascadeChild()],
      extraCounts: {
        cascadedSections: sectionsByRecipe,
        cascadedIngredients: ingredientsByRecipe,
        cascadedMealRecipes: mealRecipesByRecipe,
      },
    });
  });
};

export const deleteRecipesByCookbookTx = async (
  tx: DrizzleTransaction,
  cookbookId: CookbookId,
  actor: ActorContext,
): Promise<{ recipeIds: RecipeId[]; detachedImageKeys: string[] }> => {
  const rows = await tx.query.recipe.findMany({
    where: and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
    columns: { id: true, shortcode: true },
  });
  const ids = rows.map((r) => r.id);
  const { detachedImageKeys } = await deleteRecipes(tx, ids, actor);
  return { recipeIds: ids, detachedImageKeys };
};
