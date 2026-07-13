import {
  unsafeIngredientId,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
  unsafeRecipeId,
} from "@cubby/schemas/identifiers";
import type { SearchableEntity } from "@cubby/schemas/search";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
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

export interface SearchableEntityText {
  entityType: SearchableEntity;
  entityId: string;
  embeddingText: string;
}

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
