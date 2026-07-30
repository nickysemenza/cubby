import type {
  IngredientId,
  LocationId,
  ProductId,
  ProjectId,
  RecipeId,
} from "@cubby/schemas/identifiers";
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
import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
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
import { getDb, notDeleted } from "~/server/repo/database-helpers";

export interface OrphanedEntityEmbedding {
  id: string;
  entityType: SearchableEntity;
  entityId: string;
  model: string;
  createdAt: Date;
}

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

/**
 * Meals embed the NAMES of the recipes planned into them, so a recipe rename
 * must refresh every live meal embedding that plans it.
 */
export async function findMealEmbeddingRefsForRecipes(
  db: Database,
  recipeIds: RecipeId[],
): Promise<SearchableEntityRef[]> {
  if (recipeIds.length === 0) return [];
  const rows = await getDb(db)
    .selectDistinct({ mealId: mealRecipe.mealId })
    .from(mealRecipe)
    .innerJoin(meal, eq(meal.id, mealRecipe.mealId))
    .where(
      and(
        inArray(mealRecipe.recipeId, recipeIds),
        notDeleted(mealRecipe),
        notDeleted(meal),
      ),
    );
  return rows.map((row) => ({ entityType: "meal", entityId: row.mealId }));
}

/**
 * Tasks and expenses embed their project's NAME, so a project rename must
 * refresh every live task/expense embedding under it.
 */
export async function findTrackerEmbeddingRefsForProjects(
  db: Database,
  projectIds: ProjectId[],
): Promise<SearchableEntityRef[]> {
  if (projectIds.length === 0) return [];
  const [tasks, expenses] = await Promise.all([
    getDb(db).query.task.findMany({
      where: and(inArray(task.projectId, projectIds), notDeleted(task)),
      columns: { id: true },
    }),
    getDb(db).query.expense.findMany({
      where: and(inArray(expense.projectId, projectIds), notDeleted(expense)),
      columns: { id: true },
    }),
  ]);
  return [
    ...tasks.map(
      (row): SearchableEntityRef => ({ entityType: "task", entityId: row.id }),
    ),
    ...expenses.map(
      (row): SearchableEntityRef => ({
        entityType: "expense",
        entityId: row.id,
      }),
    ),
  ];
}

type LiveIdLoader = (db: Database, ids: string[]) => Promise<Set<string>>;

const createLiveIdLoader =
  (
    table: PgTable,
    idColumn: AnyPgColumn,
    deletedAtColumn: AnyPgColumn,
    parseId: (id: string) => string,
  ): LiveIdLoader =>
  async (db, ids) => {
    const rows = await getDb(db)
      .select({ id: idColumn })
      .from(table)
      .where(and(inArray(idColumn, ids.map(parseId)), isNull(deletedAtColumn)));
    return new Set(rows.map(({ id }) => String(id)));
  };

const liveIdLoaders = {
  product: createLiveIdLoader(
    product,
    product.id,
    product.deletedAt,
    unsafeProductId,
  ),
  recipe: createLiveIdLoader(
    recipe,
    recipe.id,
    recipe.deletedAt,
    unsafeRecipeId,
  ),
  ingredient: createLiveIdLoader(
    ingredient,
    ingredient.id,
    ingredient.deletedAt,
    unsafeIngredientId,
  ),
  cookbook: createLiveIdLoader(
    cookbook,
    cookbook.id,
    cookbook.deletedAt,
    unsafeCookbookId,
  ),
  location: createLiveIdLoader(
    location,
    location.id,
    location.deletedAt,
    unsafeLocationId,
  ),
  inventory: createLiveIdLoader(
    inventoryEntry,
    inventoryEntry.id,
    inventoryEntry.deletedAt,
    unsafeInventoryId,
  ),
  meal: createLiveIdLoader(meal, meal.id, meal.deletedAt, unsafeMealId),
  project: createLiveIdLoader(
    project,
    project.id,
    project.deletedAt,
    unsafeProjectId,
  ),
  task: createLiveIdLoader(task, task.id, task.deletedAt, unsafeTaskId),
  expense: createLiveIdLoader(
    expense,
    expense.id,
    expense.deletedAt,
    unsafeExpenseId,
  ),
} satisfies Record<SearchableEntity, LiveIdLoader>;

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
    liveByType.set(type, await liveIdLoaders[type](db, uniqueIds));
  }

  return rows.filter(
    (row) => !liveByType.get(row.entityType)?.has(row.entityId),
  );
}
