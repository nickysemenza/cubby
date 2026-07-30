import {
  unsafeCookbookId,
  unsafeExpenseId,
  unsafeIngredientId,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeMealId,
  unsafeProductId,
  unsafeProjectId,
  unsafeRecipeId,
  unsafeTaskId,
} from "@cubby/schemas/identifiers";
import type { SearchableEntity } from "@cubby/schemas/search";
import { and, eq, inArray, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import {
  cookbook,
  entityEmbedding,
  expense,
  ingredient,
  inventoryEntry,
  location,
  meal,
  mealRecipe,
  product,
  project,
  recipe,
  recipeSection,
  recipeSectionIngredient,
  task,
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
  buildCookbookEmbeddingText,
  buildExpenseEmbeddingText,
  buildIngredientEmbeddingText,
  buildInventoryEmbeddingText,
  buildLocationEmbeddingText,
  buildMealEmbeddingText,
  buildProductEmbeddingText,
  buildProjectEmbeddingText,
  buildRecipeEmbeddingText,
  buildTaskEmbeddingText,
  normalizeSearchText,
} from "~/server/semantic/text";

export interface SearchableEntityText {
  entityType: SearchableEntity;
  entityId: string;
  embeddingText: string;
}

interface EmbeddingLoadOptions {
  ids?: string[];
  limit?: number;
}

type EmbeddingTextLoader = (
  db: Database,
  options?: EmbeddingLoadOptions,
) => Promise<SearchableEntityText[]>;

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
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.product.findMany({
    where: and(
      notDeleted(product),
      options.ids?.length
        ? inArray(product.id, options.ids.map(unsafeProductId))
        : undefined,
    ),
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
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "product",
    entityId: row.id,
    embeddingText: buildProductEmbeddingText(row),
  }));
}

async function getLocationEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.location.findMany({
    where: and(
      notDeleted(location),
      options.ids?.length
        ? inArray(location.id, options.ids.map(unsafeLocationId))
        : undefined,
    ),
    columns: {
      id: true,
      name: true,
      type: true,
      aiDescription: true,
      aliases: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "location",
    entityId: row.id,
    embeddingText: buildLocationEmbeddingText(row),
  }));
}

async function getIngredientEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.ingredient.findMany({
    where: and(
      notDeleted(ingredient),
      options.ids?.length
        ? inArray(ingredient.id, options.ids.map(unsafeIngredientId))
        : undefined,
    ),
    columns: {
      id: true,
      name: true,
      aliases: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "ingredient",
    entityId: row.id,
    embeddingText: buildIngredientEmbeddingText(row),
  }));
}

async function getRecipeEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
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
    .where(
      and(
        notDeleted(recipe),
        options.ids?.length
          ? inArray(recipe.id, options.ids.map(unsafeRecipeId))
          : undefined,
      ),
    )
    .groupBy(recipe.id);
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);

  return rows.map((row) => ({
    entityType: "recipe",
    entityId: row.id,
    embeddingText: buildRecipeEmbeddingText(row),
  }));
}

async function getCookbookEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.cookbook.findMany({
    where: and(
      notDeleted(cookbook),
      options.ids?.length
        ? inArray(cookbook.id, options.ids.map(unsafeCookbookId))
        : undefined,
    ),
    columns: {
      id: true,
      name: true,
      author: true,
      subjects: true,
      sourceLabel: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "cookbook",
    entityId: row.id,
    embeddingText: buildCookbookEmbeddingText(row),
  }));
}

// A meal is usually unnamed, so the planned recipes' names carry most of its
// searchable identity — aggregated here the same way recipes fold in their
// ingredient names.
async function getMealEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: meal.id,
      name: meal.name,
      date: meal.date,
      recipeNames: sql<
        string[]
      >`array_remove(array_agg(DISTINCT ${recipe.name}), NULL)`.as(
        "recipeNames",
      ),
    })
    .from(meal)
    .leftJoin(
      mealRecipe,
      and(eq(mealRecipe.mealId, meal.id), notDeleted(mealRecipe)),
    )
    .leftJoin(
      recipe,
      and(eq(recipe.id, mealRecipe.recipeId), notDeleted(recipe)),
    )
    .where(
      and(
        notDeleted(meal),
        options.ids?.length
          ? inArray(meal.id, options.ids.map(unsafeMealId))
          : undefined,
      ),
    )
    .groupBy(meal.id);
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);

  return rows.map((row) => ({
    entityType: "meal",
    entityId: row.id,
    embeddingText: buildMealEmbeddingText(row),
  }));
}

async function getInventoryEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
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
        options.ids?.length
          ? inArray(inventoryEntry.id, options.ids.map(unsafeInventoryId))
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);

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

async function getProjectEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const rows = await getDb(db).query.project.findMany({
    where: and(
      notDeleted(project),
      options.ids?.length
        ? inArray(project.id, options.ids.map(unsafeProjectId))
        : undefined,
    ),
    columns: {
      id: true,
      name: true,
      status: true,
      kind: true,
      locations: true,
      notes: true,
    },
    ...(options.limit == null ? {} : { limit: options.limit }),
  });
  return rows.map((row) => ({
    entityType: "project",
    entityId: row.id,
    embeddingText: buildProjectEmbeddingText(row),
  }));
}

async function getTaskEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: task.id,
      name: task.name,
      status: task.status,
      trade: task.trade,
      projectName: project.name,
      subjectProductName: product.name,
    })
    .from(task)
    .leftJoin(project, eq(task.projectId, project.id))
    .leftJoin(product, eq(task.subjectProductId, product.id))
    .where(
      and(
        notDeleted(task),
        options.ids?.length
          ? inArray(task.id, options.ids.map(unsafeTaskId))
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  return rows.map((row) => ({
    entityType: "task",
    entityId: row.id,
    embeddingText: buildTaskEmbeddingText(row),
  }));
}

async function getExpenseEmbeddingTexts(
  db: Database,
  options: EmbeddingLoadOptions = {},
): Promise<SearchableEntityText[]> {
  const query = getDb(db)
    .select({
      id: expense.id,
      name: expense.name,
      costType: expense.costType,
      trade: expense.trade,
      notes: expense.notes,
      projectName: project.name,
    })
    .from(expense)
    .leftJoin(project, eq(expense.projectId, project.id))
    .where(
      and(
        notDeleted(expense),
        options.ids?.length
          ? inArray(expense.id, options.ids.map(unsafeExpenseId))
          : undefined,
      ),
    );
  const rows =
    options.limit == null ? await query : await query.limit(options.limit);
  return rows.map((row) => ({
    entityType: "expense",
    entityId: row.id,
    embeddingText: buildExpenseEmbeddingText(row),
  }));
}

const embeddingTextLoaders = {
  product: getProductEmbeddingTexts,
  recipe: getRecipeEmbeddingTexts,
  ingredient: getIngredientEmbeddingTexts,
  cookbook: getCookbookEmbeddingTexts,
  location: getLocationEmbeddingTexts,
  inventory: getInventoryEmbeddingTexts,
  meal: getMealEmbeddingTexts,
  project: getProjectEmbeddingTexts,
  task: getTaskEmbeddingTexts,
  expense: getExpenseEmbeddingTexts,
} satisfies Record<SearchableEntity, EmbeddingTextLoader>;

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
    entityTypes.map((entityType) =>
      embeddingTextLoaders[entityType](db, { limit: perTypeLimit }),
    ),
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
  const [row] = await embeddingTextLoaders[entityType](db, {
    ids: [entityId],
    limit: 1,
  });
  return row ?? null;
}
