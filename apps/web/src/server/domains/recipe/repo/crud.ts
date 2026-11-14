import type { ActorContext } from "@cubby/schemas/context";
import {
  type RecipeCreateInput,
  type RecipeUpdateInput,
} from "@cubby/schemas/entities/recipe";
import { entityRefKey } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  type CookbookId,
  parseEntityId,
  parseShortcodeFor,
  type RecipeId,
  type RecipeShortcode,
} from "@cubby/schemas/identifiers";
import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import { rawRecipeList, rawRecipeOutput } from "@cubby/schemas/recipe-raw-read";
import type {
  RawRecipeGraph as RecipeGraphOut,
  RawRecipeOutput as RecipeOut,
} from "@cubby/schemas/recipe-raw-read";
import { and, eq, inArray, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { match, P } from "ts-pattern";

import { recipeRepositoryReadSchema } from "~/entity/generated/entity-schema-bindings.recipe.gen";
import {
  collectSubRecipeIds,
  type RecipeGraphRecipe,
} from "~/lib/recipe-graph";
import { recipeOutSignature } from "~/lib/recipe-signature";
import type { Database, DrizzleTransaction } from "~/server/db";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import { DECLARED_EDGE_DELETE_HOOKS } from "~/server/db/generated/declared-edges.gen";
import {
  associatePendingImages,
  getDb,
  galleryBinding,
  mapImages,
  notDeleted,
  relations,
  unwrapDb,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { recipeSourceRelations } from "~/server/db/helpers/relations";
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
import { recipeHasImages } from "~/server/domains/image/repo/image";
import {
  mapRecipeSections,
  dbRecipeToAPIGraph,
  liveMealCountForRecipeSql,
  liveSectionCountForRecipeSql,
  recipeProvenanceFields,
  recipeTotalsFields,
} from "~/server/domains/recipe/repo/helpers";
import { recipeMetaToColumns } from "~/server/domains/recipe/repo/meta";
import { recipeSearch } from "~/server/domains/recipe/repo/search-read-recipe";
import { resolveRecipeServings } from "~/server/domains/recipe/repo/servings";
import {
  type RecipeProvenance,
  recipeSourceToColumns,
  webProvenance,
} from "~/server/domains/recipe/repo/source";
import {
  recipeCompositionLabel,
  recipeTotalsLabel,
} from "~/server/entity-kernel/repo/detail-display-labels";
import { resolveEntityDisplayImages } from "~/server/entity-kernel/repo/entity-display-image";
import {
  type MutationReceipt,
  createEntityReader,
  defineMutationWriter,
} from "~/server/entity-kernel/repo/repository";
import { createAppError } from "~/server/errors/app-error";
import {
  isUniqueViolation,
  runWithConflictRecovery,
} from "~/server/errors/db-errors";
import {
  computeChanges,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import { loadRecipeMealEvidence } from "~/server/generic/field-explanation/repo/field-explanation-evidence";
import { listScaffold } from "~/server/generic/list/repo/list";
import { recipeListLabels } from "~/server/generic/list/repo/list-display-labels";
import { deleteByPolicy } from "~/server/generic/removal/repo/dispositions";
import {
  resolveAllOrThrow,
  resolveAllPresent,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { TraceNames, withTrace } from "~/server/observability/tracing";

import {
  createSectionWithIngredients,
  handleSectionUpdates,
  replaceRecipeSections,
  updateRecipeBasicProperties,
  updateRecipeImages,
} from "./update-helpers";

export const getRecipesByIDs = async (
  db: Database,
  ids: RecipeId[],
): Promise<RecipeGraphOut[]> => {
  if (ids.length === 0) return [];
  return withTrace(TraceNames.db("recipe.getRecipesByIDs"), async (span) => {
    span.setAttribute("db.table", "recipe");
    span.setAttribute("db.requested_count", ids.length);
    const rows = await getDb(db).query.recipe.findMany({
      where: {
        RAW: (table: PgTable) =>
          relationalSql(
            table,
            and(inArray(recipe.id, ids), notDeleted(recipe)),
          ),
      },
      ...relations.recipe.list,
    });
    span.setAttribute("db.result_count", rows.length);
    const displayImages = await resolveEntityDisplayImages(
      db,
      rows.map((row) => ({ entityKind: "recipe", entityId: row.id })),
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
  roots: readonly RecipeGraphRecipe[],
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
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
        ),
    },
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
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
        ),
    },
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
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
        ),
    },
    columns: { id: true, name: true },
  });
  return new Map(rows.map((r) => [normalizeTitle(r.name), r.id]));
};

/** A nullable tag array is empty when null or zero-length. */

/** A computed total, absent until the recipe's totals are computed. */
const recipeTotalSql = (path: string) =>
  sql`CASE WHEN ${recipe.totalsPublishedAt} IS NOT NULL THEN (${recipe.totals} #>> ${sql.raw(`'${path}'`)})::numeric END`;

const qb = new QueryBuilder();

// Recipes planned into a live meal. A live MealRecipe under a soft-deleted
// Meal is not a plan — join-guarded, not just notDeleted(mealRecipe).
const recipeIdsInLiveMeals = qb
  .select({ recipeId: mealRecipe.recipeId })
  .from(mealRecipe)
  .innerJoin(meal, and(eq(meal.id, mealRecipe.mealId), notDeleted(meal)))
  .where(notDeleted(mealRecipe));

// PDFs are documents, not displayable recipe images.
const recipeIdsWithImages = qb
  .select({ recipeId: entityAttachment.entityId })
  .from(entityAttachment)
  .innerJoin(
    image,
    and(eq(image.id, entityAttachment.imageId), notDeleted(image)),
  )
  .where(
    and(notDeleted(entityAttachment), ne(image.contentType, PDF_CONTENT_TYPE)),
  );

const recipeIdsWithInstructions = qb
  .select({ recipeId: recipeSection.recipeId })
  .from(recipeSection)
  .where(
    and(
      notDeleted(recipeSection),
      sql`jsonb_array_length(${recipeSection.instructions}) > 0`,
    ),
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
const subRecipeIds = qb
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

/** Each recipe's sections, images and source relations, for the record read. */
const loadRecipeDetail = async (
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) => {
  const rows = await unwrapDb(db).query.recipe.findMany({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          inArray(
            recipe.id,
            ids.map((id) => parseEntityId("recipe", id)),
          ),
        ),
    },
    with: {
      ...recipeSourceRelations,
      sections: relations.recipe.full.with.sections,
      images: relations.recipe.full.with.images,
    },
  });
  return new Map<string, (typeof rows)[number]>(
    rows.map((row) => [row.id, row]),
  );
};

/**
 * The Recipe read, stated once: list pages, selected projections and the
 * single-record read all select through it. Pages read flat rows and scalar
 * counts, never full graphs; the thumbnail comes from the display-image
 * resolver, not an images join.
 */
export const recipeScaffold = listScaffold("recipe", recipe, {
  readSchema: recipeRepositoryReadSchema,
  derived: {
    costTotal: recipeTotalSql("{cost,lower}"),
    caloriesTotal: recipeTotalSql("{nutrition,kcal,lower}"),
    source: [
      sql`${recipe.sourceType}`,
      sql`${recipe.sourceUrl}`,
      sql`${recipe.sourceLabel}`,
    ],
    tags: sql`${recipe.tags}[1]`,
    meals: inArray(recipe.id, recipeIdsInLiveMeals),
    image: inArray(recipe.id, recipeIdsWithImages),
    instructions: inArray(recipe.id, recipeIdsWithInstructions),
    subRecipe: inArray(recipe.id, subRecipeIds),
  },
  read: {
    search: recipeSearch,
    evidence: { meals: loadRecipeMealEvidence },
    columns: {
      // The derived `tags` sorts by the first tag; the read key is the array.
      tags: recipe.tags,
      // The derived `meals` filters on planned recipes; the read key counts them.
      meals: sql<number>`(${sql.raw(liveMealCountForRecipeSql('"Recipe"."id"'))})::int`,
      sectionCount: sql<number>`(${sql.raw(
        liveSectionCountForRecipeSql('"Recipe"."id"'),
      )})::int`,
    },
    tieBreaker: sql`${recipe.name} asc`,
    media: true,
    references: {
      forkedFromRecipeId: {
        kind: "lookup",
        name: "forkedFromRecipeName",
        missing: "null",
      },
    },
    bindings: (bind) => {
      const detail = bind.ids(({ db, ids }) => loadRecipeDetail(db, ids));
      const loaded = (
        row: { id: string },
        rows: Awaited<ReturnType<typeof loadRecipeDetail>>,
      ) => {
        const value = rows.get(row.id);
        if (!value) throw new Error(`Recipe detail was not loaded: ${row.id}`);
        return value;
      };
      return [
        // A page names no cookbook or Notion page; the record read does.
        bind(
          rawRecipeList.pick({ meta: true, source: true }),
          recipeProvenanceFields,
        ),
        detail.fields(
          rawRecipeOutput.pick({ source: true }),
          (row, rows) => ({
            source: recipeProvenanceFields({ ...row, ...loaded(row, rows) })
              .source,
          }),
          { scope: "detail" },
        ),
        bind(rawRecipeList.pick({ fieldResolutions: true }), (row) => ({
          fieldResolutions: resolveRecipeServings(row),
        })),
        bind(
          rawRecipeList.pick({
            totals: true,
            storedProjectionVersions: true,
            cost: true,
            calories: true,
            protein: true,
            carbs: true,
            fat: true,
            costTotalLabel: true,
            caloriesTotalLabel: true,
            totalMinutesLabel: true,
          }),
          (row) => {
            const values = recipeTotalsFields(row);
            return {
              ...values,
              storedProjectionVersions: {
                totals: row.totalsPublishedAt?.toISOString() ?? null,
              },
              ...recipeListLabels({
                totals: values.totals,
                meta: recipeProvenanceFields(row).meta,
              }),
            };
          },
        ),
        bind(
          rawRecipeOutput.pick({ totalsLabel: true }),
          (row) => ({
            totalsLabel: recipeTotalsLabel(recipeTotalsFields(row).totals),
          }),
          { scope: "detail" },
        ),
        detail.fields(
          rawRecipeOutput.pick({ sections: true, compositionLabel: true }),
          (row, rows) => {
            const sections = mapRecipeSections(loaded(row, rows).sections);
            return {
              sections,
              compositionLabel: recipeCompositionLabel(sections),
            };
          },
          { scope: "detail" },
        ),
        detail.fields(
          rawRecipeOutput.pick({ images: true }),
          (row, rows) => ({ images: mapImages(loaded(row, rows).images) }),
          { scope: "detail" },
        ),
      ];
    },
  },
});

const recipeReader = createEntityReader<
  never,
  RecipeOut,
  "recipe",
  Database | DrizzleTransaction
>({ entity: "recipe", scaffold: recipeScaffold, output: rawRecipeOutput });
/** One live Recipe by internal id, or null. */
export const readRecipeById = recipeReader.getByIDOrNull;
/** One live Recipe by public code, or null. */
export const readRecipe = recipeReader.getByShortcode;

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
      tags: recipeInput.tags ?? [],
      notes: recipeInput.notes ?? null,
      forkedFromRecipeId,
      ...recipeMetaToColumns(recipeInput.meta),
    });
    const createdRecipeId = createdRecipe.id;

    for (const [i, section] of recipeInput.sections.entries()) {
      await createSectionWithIngredients(tx, createdRecipeId, section, i);
    }

    // Associate images if provided. `pendingImageIds` arrives as public
    // `IMG-` shortcodes (what `image.create_file_upload`/`image.uploadImage` hand
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
        galleryBinding("recipe"),
        createdRecipe.id,
        resolvedImageIds,
      );
    }

    if (withinTransaction) {
      await withinTransaction(tx, createdRecipeId);
    }

    await logAuditEntry(tx, actor, {
      entityKind: "recipe",
      entityId: createdRecipe.id,
      action: "create",
    });

    return { id: createdRecipeId, shortcode: createdRecipe.shortcode };
  });
};

export const createRecipe = defineMutationWriter({
  entity: "recipe",
  read: async (
    receipt: MutationReceipt<"recipe">,
    db: Database,
    _recipeInput: RecipeCreateInput,
    _actor: ActorContext,
    _provenance?: RecipeProvenance,
  ) => {
    const output = await readRecipeById(db, receipt.entityId);
    if (!output)
      throw createAppError(
        "RECIPE_NOT_FOUND",
        "Failed to retrieve created recipe",
      );
    return output;
  },
  write: async (
    readOutput,
    db: Database,
    recipeInput: RecipeCreateInput,
    actor: ActorContext,
    provenance?: RecipeProvenance,
  ) => {
    const { id, shortcode } = await createRecipeReturningId(
      db,
      recipeInput,
      actor,
      provenance,
    );
    return readOutput({ entityId: id, shortcode });
  },
});

/**
 * Provenance for a recipe duplicate, derived from the source's strong
 * `RecipeOut.source` union — NOT re-derived from `meta.url`, which is null for
 * anything but a Website recipe (see `dbRecipeToTopLevelShape`). Using
 * `webProvenance(meta.url)` unconditionally silently coerced every duplicate to
 * `SourceType: 'Website'`, dropping `cookbookId` for Book recipes — 94% of live
 * recipes on production.
 *
 * Book and Website provenance carry straight through: a duplicate's name always
 * gets " (copy)" appended, so it can't collide with `Recipe_cookbookId_name_key`
 * (unique on `cookbookId, name`) or `Recipe_name_key`
 * (unique on `name` alone, for Website/Other).
 *
 * A stored Notion recipe's page id is an `EntityExternalId`, unique among live
 * rows with no name component, so reusing it on the duplicate would violate
 * that index. A Notion duplicate drops to a plain "Other" copy.
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
  const source = await readRecipeById(db, id);
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
      // `source.images[].id` are public `IMG-` shortcodes (`readRecipeById`'s
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
            entityId: createdRecipeId,
            entityKind: "recipe" as const,
            role: "attachment" as const,
            imageId,
            sortOrder: i,
          })),
        );
      }
    },
  );

  const duplicated = await readRecipeById(db, newRecipeId);
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
      if (input.tags !== undefined) recipeUpdates.tags = input.tags ?? [];
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
    where: { RAW: (table: PgTable) => relationalSql(table, matchWhere) },
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
        where: { RAW: (table: PgTable) => relationalSql(table, matchWhere) },
        columns: { id: true, shortcode: true },
      });
      if (!winner) throw error;
      return updateMatched(winner.id);
    },
    (error) => isUniqueViolation(error, constraint),
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
      sql`${recipe.sourceType} IS DISTINCT FROM 'Book'`,
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
    "Recipe_cookbookId_name_key",
  );

export const updateRecipe = defineMutationWriter({
  entity: "recipe",
  read: async (
    receipt: MutationReceipt<"recipe">,
    db: Database,
    _id: RecipeId,
    _updates: RecipeUpdateInput["data"],
    _actor: ActorContext,
  ) => {
    const recipe = await readRecipeById(db, receipt.entityId);
    if (!recipe)
      throw createAppError(
        "RECIPE_NOT_FOUND",
        "Failed to retrieve updated recipe",
      );
    return { recipe, detachedImageKeys: receipt.detachedImageKeys ?? [] };
  },
  write: async (
    readOutput,
    db: Database,
    id: RecipeId,
    updates: RecipeUpdateInput["data"],
    actor: ActorContext,
  ) => {
    let detachedImageKeys: string[] = [];
    const existingRecipe =
      updates.sections !== undefined
        ? await getDb(db).query.recipe.findFirst({
            where: {
              RAW: (table: PgTable) => relationalSql(table, eq(recipe.id, id)),
            },
            with: { sections: { with: { ingredients: true } } },
          })
        : await getDb(db)
            .query.recipe.findFirst({
              where: {
                RAW: (table: PgTable) =>
                  relationalSql(table, eq(recipe.id, id)),
              },
            })
            .then((row) => (row ? { ...row, sections: [] } : undefined));

    if (!existingRecipe) {
      throw createAppError(
        "RECIPE_NOT_FOUND",
        `Recipe with ID ${id} not found`,
      );
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

      const afterState = {
        name: updates.name ?? existingRecipe.name,
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
          entityKind: "recipe",
          entityId: id,
          action: "update",
          changes,
        });
      }

      return readOutput(
        {
          entityId: id,
          shortcode: existingRecipe.shortcode,
          detachedImageKeys,
        },
        async () => {
          const recipe = await readRecipeById(tx, id);
          if (!recipe)
            throw createAppError(
              "RECIPE_NOT_FOUND",
              "Failed to retrieve updated recipe",
            );
          return { recipe, detachedImageKeys };
        },
      );
    });
    return updatedRecipe;
  },
  item: (full) => full.recipe,
});

/**
 * The graph's second hop, which no recipe edge names: the lines under its
 * sections, and the portions sourced from its meal-plan occurrences. The
 * sub-recipe pointer (`Ingredient.recipeId`) is `preserve`: the recipe Job
 * recomputes parents.
 */
export const removeRecipeGrandchildren = async (
  tx: DrizzleTransaction,
  ids: RecipeId[],
) => {
  const now = new Date();
  const sections = tx
    .select({ id: recipeSection.id })
    .from(recipeSection)
    .where(
      and(inArray(recipeSection.recipeId, ids), notDeleted(recipeSection)),
    );
  await tx
    .update(recipeSectionIngredient)
    .set({ deletedAt: now })
    .where(
      and(
        inArray(recipeSectionIngredient.recipeSectionId, sections),
        notDeleted(recipeSectionIngredient),
      ),
    );
  const occurrences = tx
    .select({ id: mealRecipe.id })
    .from(mealRecipe)
    .where(and(inArray(mealRecipe.recipeId, ids), notDeleted(mealRecipe)));
  await tx
    .update(mealRecipePortion)
    .set({ deletedAt: now })
    .where(
      and(
        inArray(mealRecipePortion.mealRecipeId, occurrences),
        notDeleted(mealRecipePortion),
      ),
    );
};

/**
 * Soft-deletes the recipe graph in the caller's transaction when provided.
 * Returned R2 keys must not be dropped until that outer transaction commits.
 */
export const deleteRecipes = (
  dbOrTx: Database | DrizzleTransaction,
  ids: RecipeId[],
  actor: ActorContext,
) =>
  deleteByPolicy(dbOrTx, {
    entity: "recipe",
    policy: DECLARED_EDGE_DELETE_POLICIES.recipe,
    ids,
    actor,
    ...DECLARED_EDGE_DELETE_HOOKS.recipe,
  });

export const deleteRecipesByCookbookTx = async (
  tx: DrizzleTransaction,
  cookbookId: CookbookId,
  actor: ActorContext,
): Promise<{ recipeIds: RecipeId[]; detachedImageKeys: string[] }> => {
  const rows = await tx.query.recipe.findMany({
    where: {
      RAW: (table: PgTable) =>
        relationalSql(
          table,
          and(eq(recipe.cookbookId, cookbookId), notDeleted(recipe)),
        ),
    },
    columns: { id: true, shortcode: true },
  });
  const ids = rows.map((r) => r.id);
  const { detachedImageKeys } = await deleteRecipes(tx, ids, actor);
  return { recipeIds: ids, detachedImageKeys };
};
