import type {
  IngredientId,
  LocationId,
  ProductId,
  ProjectId,
} from "@cubby/schemas/identifiers";
import {
  unsafeIngredientId,
  unsafeInventoryId,
  unsafeLocationId,
  unsafeProductId,
  unsafeProjectId,
  unsafePurchaseId,
  unsafeRecipeId,
  unsafeTaskId,
} from "@cubby/schemas/identifiers";
import type {
  SearchableEntity,
  SearchableEntityRef,
} from "@cubby/schemas/search";
import { and, eq, inArray } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityEmbedding,
  ingredient,
  inventoryEntry,
  location,
  product,
  project,
  purchase,
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
 * Tasks and purchases embed their project's NAME, so a project rename must
 * refresh every live task/purchase embedding under it.
 */
export async function findTrackerEmbeddingRefsForProjects(
  db: Database,
  projectIds: ProjectId[],
): Promise<SearchableEntityRef[]> {
  if (projectIds.length === 0) return [];
  const [tasks, purchases] = await Promise.all([
    getDb(db).query.task.findMany({
      where: and(inArray(task.projectId, projectIds), notDeleted(task)),
      columns: { id: true },
    }),
    getDb(db).query.purchase.findMany({
      where: and(inArray(purchase.projectId, projectIds), notDeleted(purchase)),
      columns: { id: true },
    }),
  ]);
  return [
    ...tasks.map(
      (row): SearchableEntityRef => ({ entityType: "task", entityId: row.id }),
    ),
    ...purchases.map(
      (row): SearchableEntityRef => ({
        entityType: "purchase",
        entityId: row.id,
      }),
    ),
  ];
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
            inArray(product.id, uniqueIds.map(unsafeProductId)),
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
            inArray(location.id, uniqueIds.map(unsafeLocationId)),
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
            inArray(ingredient.id, uniqueIds.map(unsafeIngredientId)),
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
            inArray(recipe.id, uniqueIds.map(unsafeRecipeId)),
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
            inArray(inventoryEntry.id, uniqueIds.map(unsafeInventoryId)),
            notDeleted(inventoryEntry),
          ),
          columns: { id: true },
        });
        liveByType.set(type, new Set(found.map((row) => row.id)));
        break;
      }
      case "project": {
        const found = await getDb(db).query.project.findMany({
          where: and(
            inArray(project.id, uniqueIds.map(unsafeProjectId)),
            notDeleted(project),
          ),
          columns: { id: true },
        });
        liveByType.set(type, new Set(found.map((row) => row.id)));
        break;
      }
      case "task": {
        const found = await getDb(db).query.task.findMany({
          where: and(
            inArray(task.id, uniqueIds.map(unsafeTaskId)),
            notDeleted(task),
          ),
          columns: { id: true },
        });
        liveByType.set(type, new Set(found.map((row) => row.id)));
        break;
      }
      case "purchase": {
        const found = await getDb(db).query.purchase.findMany({
          where: and(
            inArray(purchase.id, uniqueIds.map(unsafePurchaseId)),
            notDeleted(purchase),
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
