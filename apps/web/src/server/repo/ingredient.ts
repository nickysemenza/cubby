import type { IngredientWithRecipesAndProductOut } from "@cubby/schemas/combo";
import type { ActorContext } from "@cubby/schemas/context";
import {
  type IngredientId,
  unsafeIngredientId,
  unsafeProductShortcode,
} from "@cubby/schemas/identifiers";
import type { ingredientBase } from "@cubby/schemas/ingredient";
import {
  buildTakeSkip,
  type PaginationParams,
  type SortParams,
} from "@cubby/schemas/pagination";
import { and, count, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { z } from "zod";
import { getSortableFields } from "~/entities/entities";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  type image,
  ingredient,
  product,
  type productExternalId,
  type productUnitMappings,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  buildCascadeAuditEntries,
  computeChanges,
  logAuditEntries,
  logAuditEntry,
} from "~/server/repo/audit-log";
import {
  addProductSourceMetadata,
  assertNoDependents,
  buildOrderBy,
  countWhere,
  executeListQueryWithCount,
  extractImagesFromJoinTable,
  findOrCreate,
  formatSearchTerm,
  getDb,
  insertAndReturn,
  lockAndValidateForDelete,
  mapRelation,
  notDeleted,
  relations,
  unwrapDb,
  updateAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import {
  computeRecipeUsages,
  cookbookOnlyForIngredientSql,
  dbRecipeToAPIShallow,
  liveRecipeCountForIngredientSql,
} from "./recipe";

/**
 * Name-search standalone ingredients for the AI merge suggester's `search`
 * tool — excludes the source ingredient and surfaces each candidate's product
 * count so the model can prefer an already-enriched target (merging inherits its
 * products). Light projection (no relations); capped for the agent loop.
 */
export const searchIngredientsForMerge = async (
  db: Database,
  query: string,
  excludeId: IngredientId,
  limit = 12,
): Promise<{ id: IngredientId; name: string; productCount: number }[]> => {
  const term = formatSearchTerm(ingredient.name, query);
  const rows = await getDb(db)
    .select({
      id: ingredient.id,
      name: ingredient.name,
      productCount: sql<number>`(SELECT count(*) FROM "Product" p WHERE p."ingredientId" = ${ingredient.id} AND p."deletedAt" IS NULL)`,
    })
    .from(ingredient)
    .where(
      and(
        notDeleted(ingredient),
        isNull(ingredient.recipeId),
        ne(ingredient.id, excludeId),
        ...(term ? [term] : []),
      ),
    )
    .limit(limit);
  return rows.map((r) => ({ ...r, productCount: Number(r.productCount) }));
};

interface FuzzyMergeCandidate {
  id: IngredientId;
  name: string;
  similarity: number;
}

/**
 * Trigram (pg_trgm) near-duplicate candidates, keyed by source ingredient — the
 * workbench's inline merge hint. A self-join of the standalone-ingredient table
 * surfaces, for each ingredient, the most similar OTHERS above `threshold`,
 * preferring ones that already have a product (merging inherits enrichment). The
 * caller looks up only the rows it shows. The table is small (~hundreds), so the
 * O(n²) similarity join is cheap and avoids fragile array-parameter binding.
 *
 * Suggestion-only: trigram has real false positives (e.g. "red wine vinegar" ~
 * "white wine vinegar", "firm-ripe pears" ~ "firm ripe peaches"), so the UI must
 * confirm before merging and never auto-apply.
 */
export const findFuzzyMergeCandidates = async (
  db: Database,
  { threshold = 0.5, perRow = 3 }: { threshold?: number; perRow?: number } = {},
): Promise<Map<IngredientId, FuzzyMergeCandidate[]>> => {
  type Row = {
    source_id: string;
    cand_id: string;
    cand_name: string;
    sim: number;
    has_product: boolean;
  };
  const res = await getDb(db).execute<Row>(sql`
    SELECT s.id AS source_id, c.id AS cand_id, c.name AS cand_name,
           similarity(s.name, c.name) AS sim,
           EXISTS (
             SELECT 1 FROM "Product" p
             WHERE p."ingredientId" = c.id AND p."deletedAt" IS NULL
           ) AS has_product
    FROM ${ingredient} s
    JOIN ${ingredient} c
      ON c."deletedAt" IS NULL AND c."recipeId" IS NULL AND c.id <> s.id
     AND similarity(s.name, c.name) > ${threshold}
    WHERE s."deletedAt" IS NULL AND s."recipeId" IS NULL
    ORDER BY s.id, has_product DESC, sim DESC
  `);

  // Already ordered best-first per source; keep the top `perRow` for each.
  const out = new Map<IngredientId, FuzzyMergeCandidate[]>();
  for (const r of res.rows as unknown as Row[]) {
    const key = unsafeIngredientId(r.source_id);
    const arr = out.get(key) ?? [];
    if (arr.length >= perRow) continue;
    arr.push({
      id: unsafeIngredientId(r.cand_id),
      name: r.cand_name,
      similarity: Number(r.sim),
    });
    out.set(key, arr);
  }
  return out;
};

export const mergeIngredients = async (
  db: Database,
  target: IngredientId,
  aliases: IngredientId[],
) => {
  return await withTransaction(db, async (tx) => {
    const targetRec = await tx.query.ingredient.findFirst({
      where: eq(ingredient.id, target),
    });

    if (!targetRec) {
      throw createAppError(
        "INGREDIENT_NOT_FOUND",
        `Target ingredient ${target} not found`,
      );
    }

    const aliasRecs = await tx.query.ingredient.findMany({
      where: and(inArray(ingredient.id, aliases), notDeleted(ingredient)),
    });

    // update target ingredient to have new aliases
    await tx
      .update(ingredient)
      .set({
        aliases: uniq([
          ...targetRec.aliases,
          ...aliasRecs.map((a) => a.name),
          ...aliasRecs.flatMap((a) => a.aliases ?? []),
        ]),
      })
      .where(eq(ingredient.id, target));

    // update all recipeSectionIngredients to point to the target
    await tx
      .update(recipeSectionIngredient)
      .set({
        ingredientId: target,
      })
      .where(inArray(recipeSectionIngredient.ingredientId, aliases));

    // Re-point any products linked to the alias ingredients onto the target.
    // Otherwise the FK from Product.ingredientId blocks the hard delete below
    // (this is the whole point of merging: the surviving ingredient inherits the
    // others' products — e.g. "share this USDA food / price"). Covers
    // soft-deleted products too, since the FK applies to every row.
    await tx
      .update(product)
      .set({ ingredientId: target })
      .where(inArray(product.ingredientId, aliases));

    // delete stale
    await tx.delete(ingredient).where(inArray(ingredient.id, aliases));
  });
};

type IngredientDeepDB = typeof ingredient.$inferSelect & {
  product: Array<
    typeof product.$inferSelect & {
      unitMappings: Array<typeof productUnitMappings.$inferSelect>;
      externalIds: Array<typeof productExternalId.$inferSelect>;
      images: Array<{
        image: typeof image.$inferSelect;
      }>;
    }
  >;
  recipe: typeof recipe.$inferSelect | null;
  recipeSectionIngredient: Array<
    typeof recipeSectionIngredient.$inferSelect & {
      recipeSection: typeof recipeSection.$inferSelect & {
        recipe: typeof recipe.$inferSelect;
      };
    }
  >;
};

/**
 * Shape an ingredient's joined product rows into the API product list: brand the
 * shortcode, lift images out of the join table, drop soft-deleted external ids,
 * and attach unit-mapping source metadata. Shared by the full ingredient
 * transform and the lean enrichment-workbench fetch so they can't drift.
 */
const mapIngredientProducts = (productRel: IngredientDeepDB["product"]) =>
  mapRelation(productRel, (prod) => {
    const { ingredientId: _ingredientId, ...prodRest } = prod;
    return {
      ...prodRest,
      id: prod.id,
      shortcode: unsafeProductShortcode(prod.shortcode),
      images: extractImagesFromJoinTable(prod.images),
      externalIds: prod.externalIds.filter((eid) => eid.deletedAt === null),
      unitMappings: addProductSourceMetadata(prod.id, prod.unitMappings),
    };
  });

const dbIngredientToAPI = async (
  _db: Database | DrizzleTransaction,
  ingredientData: IngredientDeepDB,
): Promise<IngredientWithRecipesAndProductOut> => {
  const {
    product: productRel,
    recipe: recipeRel,
    recipeSectionIngredient: recipeSectionIngredientRel,
    ...restOfIngredient
  } = ingredientData;

  const productWithMappings = mapIngredientProducts(productRel);

  // One row per usage (a recipe repeats when it uses this ingredient in multiple
  // sections); the deduped `appearsInRecipes` is derived from these. Shared with
  // the product detail view via computeRecipeUsages.
  const { recipeUsages, appearsInRecipes } = computeRecipeUsages(
    recipeSectionIngredientRel ?? [],
  );

  return {
    ...restOfIngredient,
    id: restOfIngredient.id,
    recipe: recipeRel ? dbRecipeToAPIShallow(recipeRel) : null,
    product: productWithMappings,
    recipeUsages,
    appearsInRecipes,
  };
};

export const getIngredientByID = async (db: Database, id: IngredientId) => {
  const ingredientData = await getDb(db).query.ingredient.findFirst({
    where: and(eq(ingredient.id, id), notDeleted(ingredient)),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    throw createAppError("INGREDIENT_NOT_FOUND", `Ingredient ${id} not found`);
  }

  return await dbIngredientToAPI(db, ingredientData);
};

/**
 * Lean fetch of an ingredient's recipe usages — just the RecipeSectionIngredient
 * rows joined to their section + recipe, shaped by {@link computeRecipeUsages}.
 * Used by the product detail view (via the linked ingredient) to render "Appears
 * In Recipes" without loading the full ingredient graph (its other products and
 * their unit mappings).
 */
export const getRecipeUsagesForIngredient = async (
  db: Database,
  ingredientId: IngredientId,
) => {
  const rows = await getDb(db).query.recipeSectionIngredient.findMany({
    where: and(
      eq(recipeSectionIngredient.ingredientId, ingredientId),
      notDeleted(recipeSectionIngredient),
    ),
    with: {
      recipeSection: {
        with: { recipe: true },
      },
    },
  });
  return computeRecipeUsages(rows);
};

/**
 * Lean batched fetch by id for the costing path: ingredients + their products
 * (mappings / images / external ids), in ONE query via `inArray`. Deliberately
 * drops the recipe-usage relation that the full ingredient graph carries (the
 * per-usage Recipe + RecipeSection jsonb bodies) — costing, getManyByIDs, and the
 * unit-mapping analysis only read products/food, so that's a needless over-fetch
 * (~1s on a recipe's ingredient set). Missing/deleted ids are silently omitted.
 */
export const getIngredientsByIDsLean = async (
  db: Database,
  ids: IngredientId[],
) => {
  if (ids.length === 0) return [];
  const rows = await getDb(db).query.ingredient.findMany({
    where: and(inArray(ingredient.id, ids), notDeleted(ingredient)),
    with: {
      product: {
        with: {
          unitMappings: true,
          externalIds: true,
          images: { with: { image: true } },
        },
      },
    },
  });
  return rows.map((row) => {
    const { product: productRel, ...restOfIngredient } = row;
    return { ...restOfIngredient, product: mapIngredientProducts(productRel) };
  });
};

/**
 * Lean fetch for the enrichment workbench: every recipe-used standalone
 * ingredient with its products (mappings / images / external ids) plus two
 * computed scalars — `recipeCount` and `cookbookOnly`. The workbench sizes and
 * filters its worklist from these WITHOUT shipping recipe bodies: the
 * `relations.ingredient.full` path embeds the full Recipe + RecipeSection (jsonb
 * `instructions`/`totals`/`notes`) once per RSI usage — a ~24 MB payload for
 * ~1.4k ingredients that made this query ~40s (transfer + JS marshalling, not
 * Postgres). Recipe usages for the expanded-row footer load on demand via
 * {@link getRecipeUsagesForIngredient}.
 */
export const enrichmentWorkbenchIngredients = async (db: Database) => {
  // The relational query builder rewrites column refs in a custom orderBy/extras
  // to the root alias, so these correlated subqueries MUST be raw strings
  // hand-qualified to "ingredient"."id" (see ingredientList's orderBy note).
  const ref = '"ingredient"."id"';
  const recipeCountSql = liveRecipeCountForIngredientSql(ref);
  const rows = await getDb(db).query.ingredient.findMany({
    where: and(
      isNull(ingredient.recipeId),
      notDeleted(ingredient),
      // Skip the long tail of never-used ingredients up front — the workbench is
      // a worklist of recipe-used gaps.
      sql.raw(`${recipeCountSql} > 0`),
    ),
    with: {
      product: {
        with: {
          unitMappings: true,
          externalIds: true,
          images: { with: { image: true } },
        },
      },
    },
    extras: {
      recipeCount: sql<number>`${sql.raw(recipeCountSql)}`.as("recipeCount"),
      cookbookOnly: sql<boolean>`${sql.raw(
        cookbookOnlyForIngredientSql(ref),
      )}`.as("cookbookOnly"),
    },
    orderBy: [sql.raw(`${recipeCountSql} desc nulls last`)],
  });
  return rows.map((row) => {
    const {
      product: productRel,
      recipeCount,
      cookbookOnly,
      ...restOfIngredient
    } = row;
    return {
      ...restOfIngredient,
      product: mapIngredientProducts(productRel),
      // count() returns bigint (string over the wire), so coerce; the boolean comes
      // back native — `=== true` avoids the Boolean("false") === true trap if a
      // future driver ever stringifies it.
      recipeCount: Number(recipeCount),
      cookbookOnly: cookbookOnly === true,
    };
  });
};

export const getIngredientByName = async (db: Database, name: string) => {
  const res = await getDb(db).query.ingredient.findFirst({
    where: buildIngredientWhere(true, name),
    ...relations.ingredient.full,
  });
  return res ? await dbIngredientToAPI(db, res) : null;
};

/**
 * Batch counterpart to {@link getIngredientByName}: match many names in ONE
 * query (exact, case-insensitive, on name or alias). Returns a map from each
 * requested name to its match (or null). Used by the cookbook importer to show
 * the matched/new status for a whole book's ingredients without firing one
 * request per ingredient per recipe card.
 */
type IngredientNameMatch = {
  id: string;
  name: string;
  aliases: string[];
};

export const getIngredientMatches = async (
  db: Database,
  names: string[],
): Promise<Record<string, IngredientNameMatch | null>> => {
  const map: Record<string, IngredientNameMatch | null> = {};
  for (const n of names) map[n] = null;
  if (names.length === 0) return map;

  const rows = await getDb(db).query.ingredient.findMany({
    where: buildIngredientWhere(true, names[0]!, names.slice(1)),
    columns: { id: true, name: true, aliases: true },
  });

  // Index each row by its lowercased name + aliases, then assign every requested
  // name that matches. Aliases are returned so callers (e.g. instruction
  // highlighting) can recognize a matched ingredient by any of its names.
  const byKey = new Map<string, IngredientNameMatch>();
  for (const row of rows) {
    const match = { id: row.id, name: row.name, aliases: row.aliases };
    for (const key of [row.name, ...row.aliases]) {
      byKey.set(key.toLowerCase(), match);
    }
  }
  for (const n of names) {
    map[n] = byKey.get(n.toLowerCase()) ?? null;
  }
  return map;
};

export const createIngredient = async (
  db: Database | DrizzleTransaction,
  data: z.infer<typeof ingredientBase>,
  actor: ActorContext,
): Promise<IngredientWithRecipesAndProductOut> => {
  const newIngredient = await insertAndReturn(db, ingredient, {
    name: data.name,
    aliases: data.aliases || [],
  });

  // Log audit entry
  await logAuditEntry(db, actor, {
    entityType: "ingredient",
    entityId: newIngredient.id,
    action: "create",
  });

  const ingredientData = await unwrapDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, newIngredient.id),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    // INTERNAL_SERVER_ERROR (500): the row was just written, so its absence is a
    // genuine internal fault, not a missing-entity 404. No createAppError reason
    // maps to 500 here, and matches the sibling pattern in recipe/crud.ts.
    throw new Error("Failed to fetch created ingredient");
  }

  return await dbIngredientToAPI(db, ingredientData);
};

export const updateIngredient = async (
  db: Database,
  id: IngredientId,
  data: Partial<z.infer<typeof ingredientBase>>,
  actor: ActorContext,
): Promise<IngredientWithRecipesAndProductOut> => {
  // Capture before state for audit logging
  const beforeState = await getDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, id),
  });

  const updated = await updateAndReturn(
    db,
    ingredient,
    data,
    eq(ingredient.id, id),
  );

  // Log audit entry with changes
  if (beforeState) {
    const changes = computeChanges(beforeState, updated, ["name", "aliases"]);
    if (changes) {
      await logAuditEntry(db, actor, {
        entityType: "ingredient",
        entityId: id,
        action: "update",
        changes,
      });
    }
  }

  const ingredientData = await getDb(db).query.ingredient.findFirst({
    where: eq(ingredient.id, updated.id),
    ...relations.ingredient.full,
  });

  if (!ingredientData) {
    // INTERNAL_SERVER_ERROR (500): the row was just written, so its absence is a
    // genuine internal fault, not a missing-entity 404. No createAppError reason
    // maps to 500 here, and matches the sibling pattern in recipe/crud.ts.
    throw new Error("Failed to fetch updated ingredient");
  }

  return await dbIngredientToAPI(db, ingredientData);
};

export const findOrCreateIngredient = async (
  db: Database | DrizzleTransaction,
  name: string,
  aliases?: string[],
) => {
  // Atomic find-or-create. The `Ingredient_name_key` unique index is on
  // lower(name) (partial, WHERE deletedAt IS NULL), so it agrees with the
  // case-insensitive matcher — "Flour" and "flour" collide and dedupe rather
  // than both inserting. See findOrCreate for the race it closes.
  const { row: entry } = await findOrCreate(db, ingredient, {
    where: buildIngredientWhere(true, name, aliases),
    values: { name, aliases: aliases || [] },
  });

  // Add new aliases, deduped CASE-INSENSITIVELY against the name and existing
  // aliases (and against each other). Matching is case-insensitive, so appending
  // a casing-variant of an existing alias/name would only add noise to the array.
  const nameLower = name.toLowerCase();
  const seenLower = new Set(entry.aliases.map((a) => a.toLowerCase()));
  const aliasesToAdd = (aliases ?? []).filter((alias) => {
    const lower = alias.toLowerCase();
    if (lower === nameLower || seenLower.has(lower)) return false;
    seenLower.add(lower); // also dedupes casing-variants within `aliases` itself
    return true;
  });

  if (aliasesToAdd.length === 0) {
    return entry;
  }

  return await updateAndReturn(
    db,
    ingredient,
    {
      name: name,
      aliases: [...entry.aliases, ...aliasesToAdd],
    },
    eq(ingredient.id, entry.id),
  );
};

type ResolvedIngredient = {
  name: string;
  id: IngredientId;
  matched: boolean;
  created: boolean;
};

// Batch resolve-or-create: for each requested name, find the existing standalone
// ingredient (case-insensitive on name/aliases) or atomically create it, reusing
// the same matcher + race-safe `findOrCreate` primitive as findOrCreateIngredient.
// Returns one entry per non-blank input name in order, so an agent/MCP caller can
// collapse dozens of search+create round-trips into one call. Duplicate or
// casing-variant names dedupe to a single DB op; a name matching another's alias
// resolves to that existing ingredient (no duplicate row).
export const resolveOrCreateIngredients = async (
  db: Database | DrizzleTransaction,
  names: string[],
): Promise<ResolvedIngredient[]> => {
  const resolved = new Map<string, { id: IngredientId; created: boolean }>();

  for (const rawName of names) {
    const name = rawName.trim();
    const key = name.toLowerCase();
    if (key.length === 0 || resolved.has(key)) continue;
    const { row, created } = await findOrCreate(db, ingredient, {
      where: buildIngredientWhere(true, name),
      values: { name, aliases: [] },
    });
    resolved.set(key, { id: row.id, created });
  }

  const out: ResolvedIngredient[] = [];
  for (const rawName of names) {
    const entry = resolved.get(rawName.trim().toLowerCase());
    if (!entry) continue; // blank/whitespace-only name
    out.push({
      name: rawName,
      id: entry.id,
      matched: !entry.created,
      created: entry.created,
    });
  }
  return out;
};

// Case-insensitive alias match: compare lower(each alias) against the lowercased
// list. Plain `arrayOverlaps` is case-sensitive, which would disagree with the
// case-insensitive name match (and the lower(name) unique index) — e.g. an alias
// "Scallion" wouldn't match a "scallion" lookup.
const aliasMatchesCaseInsensitive = (list: string[]) => {
  const lowered = list.map((n) => n.toLowerCase());
  return sql`EXISTS (SELECT 1 FROM unnest(${ingredient.aliases}) AS t(val) WHERE lower(t.val) IN (${sql.join(
    lowered.map((v) => sql`${v}`),
    sql`, `,
  )}))`;
};

// exact:
//  true -> case-insensitive match on name or aliases
//  false -> search on name, case-insensitive match on aliases
const buildIngredientWhere = (
  exact: boolean,
  name: string,
  otherSearchNames?: string[],
) => {
  const list = [name, ...(otherSearchNames ?? [])];

  const conditions = [];

  // Name or aliases condition
  if (exact) {
    // Exact (case-insensitive) match: lower(name) IN list OR any alias matches
    conditions.push(
      or(
        inArray(
          sql`lower(${ingredient.name})`,
          list.map((n) => n.toLowerCase()),
        ),
        aliasMatchesCaseInsensitive(list),
      ),
    );
  } else {
    // Search on name (ilike), case-insensitive match on aliases
    conditions.push(
      or(
        formatSearchTerm(ingredient.name, name),
        aliasMatchesCaseInsensitive(list),
      ),
    );
  }

  // Filter for standalone ingredients only, not recipe ingredients
  conditions.push(isNull(ingredient.recipeId));

  // Filter out deleted items
  conditions.push(notDeleted(ingredient));

  return and(...conditions);
};

export const ingredientList = async (
  db: Database,
  name: string | undefined,
  sort: SortParams,
  pagination: PaginationParams,
  missingProductsOnly: boolean = false,
) => {
  // Always filter out deleted items and recipe ingredients
  const conditions = [isNull(ingredient.recipeId), notDeleted(ingredient)];

  // Add name filter if provided
  if (name) {
    const nameCondition = buildIngredientWhere(false, name);
    if (nameCondition) {
      conditions.push(nameCondition);
    }
  }

  // For missing products filter, we need to use a left join and check for null
  const whereClause = and(...conditions);

  // Build order by. `appearsInRecipes` and `product` are computed counts (not
  // real columns), so sort them via correlated subqueries. These MUST be written
  // with sql.raw: the relational query builder (query.ingredient.findMany)
  // rewrites every column reference in a custom orderBy to the root table's alias
  // ("ingredient"), which mangles cross-table refs. A raw string is opaque to that
  // rewriter, so we hand-qualify the inner tables and correlate to "ingredient"."id".
  // Everything else goes through the generic buildOrderBy.
  const dirSql =
    sort.direction === "asc" ? "asc nulls last" : "desc nulls last";
  const orderByClause =
    sort.orderBy === "appearsInRecipes"
      ? [
          // Shared with global search so the sort key matches the displayed
          // `appearsInRecipes.length` exactly (live recipes/sections/usages only).
          sql.raw(
            `${liveRecipeCountForIngredientSql('"ingredient"."id"')} ${dirSql}`,
          ),
        ]
      : sort.orderBy === "product"
        ? [
            sql.raw(
              `(SELECT count(*) FROM "Product" p ` +
                `WHERE p."ingredientId" = "ingredient"."id" AND p."deletedAt" IS NULL) ${dirSql}`,
            ),
          ]
        : buildOrderBy(ingredient, sort, [...getSortableFields("ingredient")]);

  const { take, skip } = buildTakeSkip(pagination);

  if (missingProductsOnly) {
    // Use a subquery to find ingredients with no products
    const ingredientsWithNoProducts = getDb(db)
      .select({ id: ingredient.id })
      .from(ingredient)
      .leftJoin(product, eq(product.ingredientId, ingredient.id))
      .where(and(whereClause, isNull(product.id)))
      .groupBy(ingredient.id)
      .as("filtered");

    const { data: results, count: totalCount } =
      await executeListQueryWithCount(
        getDb(db).query.ingredient.findMany({
          where: inArray(
            ingredient.id,
            getDb(db)
              .select({ id: ingredientsWithNoProducts.id })
              .from(ingredientsWithNoProducts),
          ),
          ...relations.ingredient.full,
          orderBy: orderByClause,
          limit: take,
          offset: skip,
        }),
        getDb(db)
          .select({ count: count() })
          .from(ingredient)
          .leftJoin(product, eq(product.ingredientId, ingredient.id))
          .where(and(whereClause, isNull(product.id)))
          .then((rows) => rows[0]?.count ?? 0),
      );

    const ingredients = await Promise.all(
      results.map((ing) => dbIngredientToAPI(db, ing)),
    );

    return { data: ingredients, count: totalCount };
  } else {
    // Normal query without missing products filter
    const { data: results, count: totalCount } =
      await executeListQueryWithCount(
        getDb(db).query.ingredient.findMany({
          where: whereClause,
          ...relations.ingredient.full,
          orderBy: orderByClause,
          limit: take,
          offset: skip,
        }),
        countWhere(db, ingredient, whereClause),
      );

    const ingredients = await Promise.all(
      results.map((ing) => dbIngredientToAPI(db, ing)),
    );

    return { data: ingredients, count: totalCount };
  }
};

/**
 * Soft delete ingredients by setting deletedAt timestamp.
 * Throws if any ingredient is used in recipes or linked to products.
 */
export const deleteIngredients = async (
  db: Database,
  ids: IngredientId[],
  actor: ActorContext,
): Promise<void> => {
  if (ids.length === 0) return;

  // Perform safety checks and soft delete in a transaction for atomicity
  await withTransaction(db, async (tx) => {
    // Lock ingredients and validate they exist and aren't already deleted
    // Prevents race conditions by acquiring row-level locks
    await lockAndValidateForDelete(tx, ingredient, ids, "Ingredient");

    // Safety check: don't delete if any are used in *live* recipes. Must filter
    // all three join levels (usage → section → recipe) so an ingredient whose
    // only usages live in soft-deleted recipes doesn't block deletion — this
    // matches the liveness semantics of `liveRecipeCountForIngredientSql` used by
    // the read surfaces, so the guard and the displayed recipe count never
    // disagree. A shallow `notDeleted(rsi)`-only check trips on orphaned usage
    // rows whose parent recipe was soft-deleted (legacy/out-of-band rows).
    const usedInRecipes = await tx
      .selectDistinct({ ingredientId: recipeSectionIngredient.ingredientId })
      .from(recipeSectionIngredient)
      .innerJoin(
        recipeSection,
        and(
          eq(recipeSection.id, recipeSectionIngredient.recipeSectionId),
          notDeleted(recipeSection),
        ),
      )
      .innerJoin(
        recipe,
        and(eq(recipe.id, recipeSection.recipeId), notDeleted(recipe)),
      )
      .where(
        and(
          inArray(recipeSectionIngredient.ingredientId, ids),
          notDeleted(recipeSectionIngredient),
        ),
      );
    const fetchIngredientNames = (failedIds: IngredientId[]) =>
      tx.query.ingredient.findMany({
        where: inArray(ingredient.id, failedIds),
        columns: { name: true },
      });
    await assertNoDependents({
      offendingParentIds: usedInRecipes.map((r) => r.ingredientId),
      fetchNames: fetchIngredientNames,
      reason: "INGREDIENT_HAS_RECIPES",
      message: (count, names) =>
        `Cannot delete ${count} ingredient(s): ${names} are used in recipes.`,
    });

    // Safety check: don't delete if any are linked to products
    const linkedProducts = await tx.query.product.findMany({
      where: and(inArray(product.ingredientId, ids), notDeleted(product)),
      columns: { ingredientId: true },
    });
    await assertNoDependents({
      offendingParentIds: linkedProducts.map((p) => p.ingredientId),
      fetchNames: fetchIngredientNames,
      reason: "INGREDIENT_HAS_PRODUCTS",
      message: (count, names) =>
        `Cannot delete ${count} ingredient(s): ${names} have linked products.`,
    });

    const now = new Date();

    await tx
      .update(ingredient)
      .set({ deletedAt: now })
      .where(inArray(ingredient.id, ids));

    // No cascaded items for ingredients — plain delete audit entries.
    const auditEntries = buildCascadeAuditEntries("ingredient", ids);

    await logAuditEntries(tx, actor, auditEntries);
  });
};
