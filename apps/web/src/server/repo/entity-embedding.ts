import type {
  IngredientId,
  LocationId,
  ProductId,
} from "@cubby/schemas/identifiers";
import {
  unsafeIngredientId,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityEmbedding,
  ingredient,
  inventoryEntry,
  location,
  product,
  recipe,
  recipeSection,
  recipeSectionIngredient,
} from "~/server/db/schema";
import {
  getDb,
  insertAndReturn,
  notDeleted,
  updateAndReturn,
} from "~/server/repo/database-helpers";
import type { SemanticEmbeddingConfig } from "~/server/semantic/config";
import { embeddingTextHash } from "~/server/semantic/hash";
import {
  buildIngredientEmbeddingText,
  buildInventoryEmbeddingText,
  buildLocationEmbeddingText,
  buildProductEmbeddingText,
  buildRecipeEmbeddingText,
  normalizeSearchText,
} from "~/server/semantic/text";

interface EntityEmbeddingCandidate {
  entityType: SearchableEntity;
  entityId: string;
  similarity: number;
}

interface SearchableEntityText {
  entityType: SearchableEntity;
  entityId: string;
  embeddingText: string;
}

interface OrphanedEntityEmbedding {
  id: string;
  entityType: SearchableEntity;
  entityId: string;
  model: string;
  createdAt: Date;
}

const vectorLiteral = (embedding: number[]): ReturnType<typeof sql.raw> => {
  if (
    embedding.length === 0 ||
    embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error("Invalid embedding vector");
  }
  return sql.raw(`'[${embedding.join(",")}]'::vector`);
};

const semanticCandidateQueryErrorDetails = (
  error: unknown,
): Record<string, unknown> => {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const pgError = cause as
    | {
        code?: unknown;
        severity?: unknown;
        detail?: unknown;
        hint?: unknown;
        routine?: unknown;
      }
    | null
    | undefined;

  return {
    errorName: error instanceof Error ? error.name : typeof error,
    pgCode: pgError?.code,
    severity: pgError?.severity,
    detail: pgError?.detail,
    hint: pgError?.hint,
    routine: pgError?.routine,
  };
};

export async function upsertEntityEmbedding(
  db: Database,
  input: SearchableEntityText & {
    config: SemanticEmbeddingConfig;
    embedding: number[];
  },
): Promise<void> {
  const embeddingHash = await embeddingTextHash({
    entityType: input.entityType,
    provider: input.config.provider,
    model: input.config.model,
    dimensions: input.config.dimensions,
    text: normalizeSearchText(input.embeddingText),
  });

  const existing = await getDb(db).query.entityEmbedding.findFirst({
    where: and(
      eq(entityEmbedding.entityType, input.entityType),
      eq(entityEmbedding.entityId, input.entityId),
      eq(entityEmbedding.provider, input.config.provider),
      eq(entityEmbedding.model, input.config.model),
      eq(entityEmbedding.dimensions, input.config.dimensions),
      notDeleted(entityEmbedding),
    ),
    columns: { id: true, embeddingHash: true },
  });

  if (existing?.embeddingHash === embeddingHash) return;

  const values = {
    entityType: input.entityType,
    entityId: input.entityId,
    embeddingText: input.embeddingText,
    embeddingHash,
    provider: input.config.provider,
    model: input.config.model,
    dimensions: input.config.dimensions,
    embedding: input.embedding,
    deletedAt: null,
  };

  if (existing) {
    await updateAndReturn(
      db,
      entityEmbedding,
      values,
      eq(entityEmbedding.id, existing.id),
    );
    return;
  }

  await insertAndReturn(db, entityEmbedding, values);
}

/**
 * Soft-delete the embedding rows owned by the given entities, INSIDE an existing
 * transaction. This lives at the repo-delete layer (called from each entity's
 * delete cascade) so EVERY delete caller drops the embedding atomically with the
 * entity — the mutation-side-effect handler only covered the router path, so a
 * direct repo delete (e.g. problems.service.deleteUnusedIngredients, which calls
 * deleteProducts/deleteIngredients without side-effects) orphaned the embedding.
 */
export async function softDeleteEntityEmbeddingsTx(
  tx: DrizzleTransaction,
  entityType: SearchableEntity,
  entityIds: string[],
): Promise<void> {
  if (entityIds.length === 0) return;
  await tx
    .update(entityEmbedding)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(entityEmbedding.entityType, entityType),
        inArray(entityEmbedding.entityId, entityIds),
        notDeleted(entityEmbedding),
      ),
    );
}

export async function softDeleteEntityEmbeddingRows(
  db: Database,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await getDb(db)
    .update(entityEmbedding)
    .set({ deletedAt: new Date() })
    .where(and(inArray(entityEmbedding.id, ids), notDeleted(entityEmbedding)))
    .returning({ id: entityEmbedding.id });
  return rows.length;
}

export async function getEntityEmbeddingDeletedAt(
  db: Database,
  id: string,
): Promise<Date | null | undefined> {
  const row = await getDb(db).query.entityEmbedding.findFirst({
    where: eq(entityEmbedding.id, id),
    columns: { deletedAt: true },
  });
  return row?.deletedAt;
}

export async function getEntityEmbeddingDeletedAtForRef(
  db: Database,
  ref: SearchableEntityRef,
): Promise<Date | null | undefined> {
  const row = await getDb(db).query.entityEmbedding.findFirst({
    where: and(
      eq(entityEmbedding.entityType, ref.entityType),
      eq(entityEmbedding.entityId, ref.entityId),
    ),
    columns: { deletedAt: true },
  });
  return row?.deletedAt;
}

export async function findInventoryEmbeddingRefsForProducts(
  db: Database,
  productIds: ProductId[],
): Promise<SearchableEntityRef[]> {
  if (productIds.length === 0) return [];
  const rows = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.productId, productIds),
      notDeleted(inventoryEntry),
    ),
    columns: { id: true },
  });
  return rows.map((row) => ({ entityType: "inventory", entityId: row.id }));
}

export async function findInventoryEmbeddingRefsForLocations(
  db: Database,
  locationIds: LocationId[],
): Promise<SearchableEntityRef[]> {
  if (locationIds.length === 0) return [];
  const rows = await getDb(db).query.inventoryEntry.findMany({
    where: and(
      inArray(inventoryEntry.locationId, locationIds),
      notDeleted(inventoryEntry),
    ),
    columns: { id: true },
  });
  return rows.map((row) => ({ entityType: "inventory", entityId: row.id }));
}

export async function findRecipeEmbeddingRefsForIngredients(
  db: Database,
  ingredientIds: IngredientId[],
): Promise<SearchableEntityRef[]> {
  if (ingredientIds.length === 0) return [];
  const rows = await getDb(db)
    .selectDistinct({ recipeId: recipeSection.recipeId })
    .from(recipeSectionIngredient)
    .innerJoin(
      recipeSection,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .innerJoin(recipe, eq(recipe.id, recipeSection.recipeId))
    .where(
      and(
        inArray(recipeSectionIngredient.ingredientId, ingredientIds),
        notDeleted(recipeSectionIngredient),
        notDeleted(recipeSection),
        notDeleted(recipe),
      ),
    );
  return rows.map((row) => ({ entityType: "recipe", entityId: row.recipeId }));
}

export async function findOrphanedEntityEmbeddings(
  db: Database,
): Promise<OrphanedEntityEmbedding[]> {
  const rows = await getDb(db).query.entityEmbedding.findMany({
    where: notDeleted(entityEmbedding),
    columns: {
      id: true,
      entityType: true,
      entityId: true,
      model: true,
      createdAt: true,
    },
  });
  const byType = new Map<SearchableEntity, string[]>();
  for (const row of rows) {
    const ids = byType.get(row.entityType) ?? [];
    ids.push(row.entityId);
    byType.set(row.entityType, ids);
  }

  const liveByType = new Map<SearchableEntity, Set<string>>();
  for (const [type, ids] of byType.entries()) {
    const uniqueIds = uniq(ids);
    if (uniqueIds.length === 0) continue;
    switch (type) {
      case "product": {
        const found = await getDb(db).query.product.findMany({
          where: and(
            inArray(
              product.id,
              uniqueIds.map((id) => unsafeProductId(id)),
            ),
            notDeleted(product),
          ),
          columns: { id: true },
        });
        liveByType.set(type, new Set(found.map((row) => row.id)));
        break;
      }
      case "location": {
        const found = await getDb(db).query.location.findMany({
          where: and(
            inArray(
              location.id,
              uniqueIds.map((id) => unsafeLocationId(id)),
            ),
            notDeleted(location),
          ),
          columns: { id: true },
        });
        liveByType.set(type, new Set(found.map((row) => row.id)));
        break;
      }
      case "ingredient": {
        const found = await getDb(db).query.ingredient.findMany({
          where: and(
            inArray(
              ingredient.id,
              uniqueIds.map((id) => unsafeIngredientId(id)),
            ),
            notDeleted(ingredient),
          ),
          columns: { id: true },
        });
        liveByType.set(type, new Set(found.map((row) => row.id)));
        break;
      }
      case "recipe": {
        const found = await getDb(db).query.recipe.findMany({
          where: and(
            inArray(
              recipe.id,
              uniqueIds.map((id) => unsafeRecipeId(id)),
            ),
            notDeleted(recipe),
          ),
          columns: { id: true },
        });
        liveByType.set(type, new Set(found.map((row) => row.id)));
        break;
      }
      case "inventory": {
        const found = await getDb(db).query.inventoryEntry.findMany({
          where: and(
            inArray(
              inventoryEntry.id,
              uniqueIds.map((id) => unsafeInventoryId(id)),
            ),
            notDeleted(inventoryEntry),
          ),
          columns: { id: true },
        });
        liveByType.set(type, new Set(found.map((row) => row.id)));
        break;
      }
      default: {
        const exhaustive: never = type;
        throw new Error(`Unsupported searchable entity: ${exhaustive}`);
      }
    }
  }

  return rows.filter(
    (row) => !liveByType.get(row.entityType)?.has(row.entityId),
  );
}

export async function findSemanticEntityCandidates(
  db: Database,
  queryEmbedding: number[],
  config: SemanticEmbeddingConfig,
  opts: { entityTypes?: SearchableEntity[]; limit: number },
): Promise<EntityEmbeddingCandidate[]> {
  let rows: Array<{
    entityType: SearchableEntity;
    entityId: string;
    similarity: string | number;
  }>;
  try {
    const typeFilter =
      opts.entityTypes && opts.entityTypes.length > 0
        ? sql`AND ee."entityType" IN (${sql.join(
            opts.entityTypes.map((entityType) => sql`${entityType}`),
            sql`, `,
          )})`
        : sql``;
    const vector = vectorLiteral(queryEmbedding);
    // The `embedding::vector(N)` cast must match the expression in
    // EntityEmbedding_embedding_hnsw_idx exactly, or the planner falls back
    // to a seq scan (the raw column is untyped `vector`, which pgvector
    // can't index directly). config.dimensions is a number from
    // AI_MODEL_REGISTRY, safe to inline raw.
    const castEmbedding = sql.raw(
      `ee."embedding"::vector(${config.dimensions})`,
    );
    const result = await getDb(db).execute<{
      entityType: SearchableEntity;
      entityId: string;
      similarity: string | number;
    }>(sql`
      SELECT
        ee."entityType" AS "entityType",
        ee."entityId"::text AS "entityId",
        1 - (${castEmbedding} <=> ${vector}) AS "similarity"
      FROM "EntityEmbedding" ee
      WHERE ee."deletedAt" IS NULL
        AND ee."provider" = ${config.provider}
        AND ee."model" = ${config.model}
        AND ee."dimensions" = ${config.dimensions}
        ${typeFilter}
      ORDER BY ${castEmbedding} <=> ${vector}
      LIMIT ${opts.limit}
    `);
    rows = result.rows as Array<{
      entityType: SearchableEntity;
      entityId: string;
      similarity: string | number;
    }>;
  } catch (error) {
    console.error("semantic.entity-candidates.failed", {
      ...semanticCandidateQueryErrorDetails(error),
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      entityTypes: opts.entityTypes ?? null,
      limit: opts.limit,
      embeddingDimensions: queryEmbedding.length,
    });
    throw new Error(
      "Semantic search failed while reading entity embeddings. Check pgvector setup and embedding dimensions.",
    );
  }
  return rows.map((row) => ({
    entityType: row.entityType,
    entityId: row.entityId,
    similarity:
      typeof row.similarity === "number"
        ? row.similarity
        : Number.parseFloat(row.similarity),
  }));
}

async function getProductEmbeddingTexts(
  db: Database,
  limit?: number,
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.product.findMany({
    where: notDeleted(product),
    columns: {
      id: true,
      name: true,
      manufacturer: true,
      category: true,
      model: true,
      upc: true,
      notes: true,
      aliases: true,
    },
    ...(limit == null ? {} : { limit }),
  });
  return rows.map((row) => ({
    entityType: "product",
    entityId: row.id,
    embeddingText: buildProductEmbeddingText(row),
  }));
}

async function getLocationEmbeddingTexts(
  db: Database,
  limit?: number,
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.location.findMany({
    where: notDeleted(location),
    columns: {
      id: true,
      name: true,
      type: true,
      aiDescription: true,
      aliases: true,
    },
    ...(limit == null ? {} : { limit }),
  });
  return rows.map((row) => ({
    entityType: "location",
    entityId: row.id,
    embeddingText: buildLocationEmbeddingText(row),
  }));
}

async function getIngredientEmbeddingTexts(
  db: Database,
  limit?: number,
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.ingredient.findMany({
    where: notDeleted(ingredient),
    columns: {
      id: true,
      name: true,
      aliases: true,
    },
    ...(limit == null ? {} : { limit }),
  });
  return rows.map((row) => ({
    entityType: "ingredient",
    entityId: row.id,
    embeddingText: buildIngredientEmbeddingText(row),
  }));
}

async function getRecipeEmbeddingTexts(
  db: Database,
  limit?: number,
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: recipe.id,
      name: recipe.name,
      tags: recipe.tags,
      notes: recipe.notes,
      ingredientNames: sql<
        string[]
      >`array_remove(array_agg(DISTINCT ${ingredient.name}), NULL)`.as(
        "ingredientNames",
      ),
    })
    .from(recipe)
    .leftJoin(recipeSection, eq(recipeSection.recipeId, recipe.id))
    .leftJoin(
      recipeSectionIngredient,
      eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
    )
    .leftJoin(
      ingredient,
      eq(ingredient.id, recipeSectionIngredient.ingredientId),
    )
    .where(notDeleted(recipe))
    .groupBy(recipe.id);
  const rows = limit == null ? await query : await query.limit(limit);

  return rows.map((row) => ({
    entityType: "recipe",
    entityId: row.id,
    embeddingText: buildRecipeEmbeddingText(row),
  }));
}

async function getInventoryEmbeddingTexts(
  db: Database,
  limit?: number,
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: inventoryEntry.id,
      amount: inventoryEntry.amount,
      locationName: location.name,
      productName: product.name,
      manufacturer: product.manufacturer,
      category: product.category,
      model: product.model,
      upc: product.upc,
      notes: product.notes,
      aliases: product.aliases,
    })
    .from(inventoryEntry)
    .innerJoin(product, eq(inventoryEntry.productId, product.id))
    .innerJoin(location, eq(inventoryEntry.locationId, location.id))
    .where(
      and(
        notDeleted(inventoryEntry),
        notDeleted(product),
        notDeleted(location),
      ),
    );
  const rows = limit == null ? await query : await query.limit(limit);

  return rows.map((row) => ({
    entityType: "inventory",
    entityId: row.id,
    embeddingText: buildInventoryEmbeddingText({
      productText: buildProductEmbeddingText({
        name: row.productName,
        manufacturer: row.manufacturer,
        category: row.category,
        model: row.model,
        upc: row.upc,
        notes: row.notes,
        aliases: row.aliases,
      }),
      locationPath: row.locationName,
      amount: row.amount,
    }),
  }));
}

export async function getEmbeddingTextsForEntityTypes(
  db: Database,
  entityTypes: SearchableEntity[],
  limit?: number,
): Promise<SearchableEntityText[]> {
  const perTypeLimit =
    limit == null
      ? undefined
      : Math.max(1, Math.ceil(limit / entityTypes.length));
  const chunks = await Promise.all(
    entityTypes.map((entityType) => {
      switch (entityType) {
        case "product":
          return getProductEmbeddingTexts(db, perTypeLimit);
        case "location":
          return getLocationEmbeddingTexts(db, perTypeLimit);
        case "ingredient":
          return getIngredientEmbeddingTexts(db, perTypeLimit);
        case "recipe":
          return getRecipeEmbeddingTexts(db, perTypeLimit);
        case "inventory":
          return getInventoryEmbeddingTexts(db, perTypeLimit);
        default: {
          const exhaustive: never = entityType;
          throw new Error(`Unsupported searchable entity: ${exhaustive}`);
        }
      }
    }),
  );
  const rows = chunks.flat();
  return limit == null ? rows : rows.slice(0, limit);
}

// When a limit is requested, scan a bounded window instead of the whole catalog.
// Overscan so a fresh-heavy prefix doesn't starve the batch; the backfill action
// is re-runnable to catch any stale rows beyond the window.
const STALE_SCAN_OVERSCAN = 4;

export async function getStaleEmbeddingTextsForEntityTypes(
  db: Database,
  entityTypes: SearchableEntity[],
  config: SemanticEmbeddingConfig,
  limit?: number,
): Promise<SearchableEntityText[]> {
  const rows = await getEmbeddingTextsForEntityTypes(
    db,
    entityTypes,
    limit == null ? undefined : limit * STALE_SCAN_OVERSCAN,
  );
  if (rows.length === 0) return [];

  const ids = uniq(rows.map((row) => row.entityId));
  const existingRows = await getDb(db).query.entityEmbedding.findMany({
    where: and(
      inArray(entityEmbedding.entityType, entityTypes),
      inArray(entityEmbedding.entityId, ids),
      eq(entityEmbedding.provider, config.provider),
      eq(entityEmbedding.model, config.model),
      eq(entityEmbedding.dimensions, config.dimensions),
      notDeleted(entityEmbedding),
    ),
    columns: {
      entityType: true,
      entityId: true,
      embeddingHash: true,
    },
  });
  const existingByEntity = new Map(
    existingRows.map((row) => [
      `${row.entityType}:${row.entityId}`,
      row.embeddingHash,
    ]),
  );

  const staleRows: SearchableEntityText[] = [];
  for (const row of rows) {
    const hash = await embeddingTextHash({
      entityType: row.entityType,
      provider: config.provider,
      model: config.model,
      dimensions: config.dimensions,
      text: normalizeSearchText(row.embeddingText),
    });
    if (existingByEntity.get(`${row.entityType}:${row.entityId}`) !== hash) {
      staleRows.push(row);
    }
    if (limit != null && staleRows.length >= limit) break;
  }

  return staleRows;
}

export async function getEmbeddingTextForEntity(
  db: Database,
  entityType: SearchableEntity,
  entityId: string,
): Promise<SearchableEntityText | null> {
  switch (entityType) {
    case "product": {
      const id = unsafeProductId(entityId);
      const row = await getDb(db).query.product.findFirst({
        where: and(eq(product.id, id), notDeleted(product)),
        columns: {
          id: true,
          name: true,
          manufacturer: true,
          category: true,
          model: true,
          upc: true,
          notes: true,
          aliases: true,
        },
      });
      return row
        ? {
            entityType,
            entityId: row.id,
            embeddingText: buildProductEmbeddingText(row),
          }
        : null;
    }
    case "location": {
      const id = unsafeLocationId(entityId);
      const row = await getDb(db).query.location.findFirst({
        where: and(eq(location.id, id), notDeleted(location)),
        columns: {
          id: true,
          name: true,
          type: true,
          aiDescription: true,
          aliases: true,
        },
      });
      return row
        ? {
            entityType,
            entityId: row.id,
            embeddingText: buildLocationEmbeddingText(row),
          }
        : null;
    }
    case "ingredient": {
      const id = unsafeIngredientId(entityId);
      const row = await getDb(db).query.ingredient.findFirst({
        where: and(eq(ingredient.id, id), notDeleted(ingredient)),
        columns: {
          id: true,
          name: true,
          aliases: true,
        },
      });
      return row
        ? {
            entityType,
            entityId: row.id,
            embeddingText: buildIngredientEmbeddingText(row),
          }
        : null;
    }
    case "recipe": {
      const id = unsafeRecipeId(entityId);
      const [row] = await getDb(db)
        .select({
          id: recipe.id,
          name: recipe.name,
          tags: recipe.tags,
          notes: recipe.notes,
          ingredientNames: sql<
            string[]
          >`array_remove(array_agg(DISTINCT ${ingredient.name}), NULL)`.as(
            "ingredientNames",
          ),
        })
        .from(recipe)
        .leftJoin(recipeSection, eq(recipeSection.recipeId, recipe.id))
        .leftJoin(
          recipeSectionIngredient,
          eq(recipeSectionIngredient.recipeSectionId, recipeSection.id),
        )
        .leftJoin(
          ingredient,
          eq(ingredient.id, recipeSectionIngredient.ingredientId),
        )
        .where(and(eq(recipe.id, id), notDeleted(recipe)))
        .groupBy(recipe.id)
        .limit(1);
      return row
        ? {
            entityType,
            entityId: row.id,
            embeddingText: buildRecipeEmbeddingText(row),
          }
        : null;
    }
    case "inventory": {
      const id = unsafeInventoryId(entityId);
      const [row] = await getDb(db)
        .select({
          id: inventoryEntry.id,
          amount: inventoryEntry.amount,
          locationName: location.name,
          productName: product.name,
          manufacturer: product.manufacturer,
          category: product.category,
          model: product.model,
          upc: product.upc,
          notes: product.notes,
          aliases: product.aliases,
        })
        .from(inventoryEntry)
        .innerJoin(product, eq(inventoryEntry.productId, product.id))
        .innerJoin(location, eq(inventoryEntry.locationId, location.id))
        .where(
          and(
            eq(inventoryEntry.id, id),
            notDeleted(inventoryEntry),
            notDeleted(product),
            notDeleted(location),
          ),
        )
        .limit(1);
      return row
        ? {
            entityType,
            entityId: row.id,
            embeddingText: buildInventoryEmbeddingText({
              productText: buildProductEmbeddingText({
                name: row.productName,
                manufacturer: row.manufacturer,
                category: row.category,
                model: row.model,
                upc: row.upc,
                notes: row.notes,
                aliases: row.aliases,
              }),
              locationPath: row.locationName,
              amount: row.amount,
            }),
          }
        : null;
    }
    default: {
      const exhaustive: never = entityType;
      throw new Error(`Unsupported searchable entity: ${exhaustive}`);
    }
  }
}
