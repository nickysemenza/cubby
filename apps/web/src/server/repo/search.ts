import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import type {
  IngredientSearchResult,
  InventorySearchResult,
  LocationSearchResult,
  ProductSearchResult,
  ProjectSearchResult,
  PurchaseSearchResult,
  RecipeSearchResult,
  SearchableEntity,
  SearchResultItem,
  TaskSearchResult,
} from "@cubby/schemas/search";
import { type AnyColumn, and, eq, isNull, or, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  ingredient,
  inventoryEntry,
  location,
  product,
  project,
  purchase,
  recipe,
  task,
} from "~/server/db/schema";
import { formatSearchTerm, getDb, notDeleted } from "./database-helpers";
import { liveRecipeCountForIngredientSql } from "./recipe";

const formatArraySearchTerm = (
  column: AnyColumn,
  query: string,
): ReturnType<typeof sql> =>
  sql`EXISTS (SELECT 1 FROM unnest(${column}) AS alias WHERE alias ILIKE ${`%${query}%`})`;

const idIn = (column: AnyColumn, ids: string[]): ReturnType<typeof sql> =>
  sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;

/**
 * Global search across all entity types using parallel queries.
 * Returns a flat array of results ordered by entity type.
 */
export async function globalSearch(
  db: Database,
  query: string,
  limitPerType = 5,
): Promise<SearchResultItem[]> {
  const client = getDb(db);

  // Run 8 parallel queries - each returns its discriminated union variant
  const [
    products,
    recipes,
    ingredients,
    locations,
    inventory,
    projects,
    tasks,
    purchases,
  ] = await Promise.all([
    // Product: search name, manufacturer, upc
    client
      .select({
        id: product.id,
        name: product.name,
        subtitle: product.manufacturer,
        entityType: sql<"product">`'product'`.as("entityType"),
        typeHint: product.category,
        imageUrl: sql<string | null>`(
            SELECT i."url" FROM "ProductImage" pi
            JOIN "Image" i ON i."id" = pi."imageId"
            WHERE pi."productId" = "Product"."id"
            AND pi."deletedAt" IS NULL
            AND i."deletedAt" IS NULL
            AND i."contentType" <> ${PDF_CONTENT_TYPE}
            ORDER BY pi."createdAt" ASC
            LIMIT 1
          )`.as("imageUrl"),
        createdAt: product.createdAt,
        price: product.price,
        stockCount: sql<number>`(
            SELECT COUNT(*)::int FROM "InventoryEntry" ie
            WHERE ie."productId" = "Product"."id"
            AND ie."deletedAt" IS NULL
          )`.as("stockCount"),
      })
      .from(product)
      .where(
        and(
          notDeleted(product),
          or(
            formatSearchTerm(product.name, query),
            formatArraySearchTerm(product.aliases, query),
            formatSearchTerm(product.manufacturer, query),
            formatSearchTerm(product.upc, query),
          ),
        ),
      )
      .limit(limitPerType) as Promise<ProductSearchResult[]>,

    // Recipe: search name only
    client
      .select({
        id: recipe.id,
        name: recipe.name,
        subtitle: sql<string | null>`null`.as("subtitle"),
        entityType: sql<"recipe">`'recipe'`.as("entityType"),
        typeHint: sql<string | null>`null`.as("typeHint"),
        imageUrl: sql<string | null>`(
            SELECT i."url" FROM "RecipeImage" ri
            JOIN "Image" i ON i."id" = ri."imageId"
            WHERE ri."recipeId" = "Recipe"."id"
            AND ri."deletedAt" IS NULL
            AND i."deletedAt" IS NULL
            AND i."contentType" <> ${PDF_CONTENT_TYPE}
            ORDER BY ri."createdAt" ASC
            LIMIT 1
          )`.as("imageUrl"),
        createdAt: recipe.createdAt,
        ingredientCount: sql<number>`(
            SELECT COUNT(*)::int FROM "RecipeSectionIngredient" rsi
            JOIN "RecipeSection" rs ON rsi."recipeSectionId" = rs.id AND rs."deletedAt" IS NULL
            WHERE rs."recipeId" = "Recipe"."id" AND rsi."deletedAt" IS NULL
          )`.as("ingredientCount"),
      })
      .from(recipe)
      .where(and(notDeleted(recipe), formatSearchTerm(recipe.name, query)))
      .limit(limitPerType) as Promise<RecipeSearchResult[]>,

    // Ingredient: search name
    client
      .select({
        id: ingredient.id,
        name: ingredient.name,
        subtitle: sql<string | null>`null`.as("subtitle"),
        entityType: sql<"ingredient">`'ingredient'`.as("entityType"),
        typeHint: sql<string | null>`null`.as("typeHint"),
        imageUrl: sql<string | null>`null`.as("imageUrl"),
        createdAt: ingredient.createdAt,
        recipeCount: sql<number>`${sql.raw(
          liveRecipeCountForIngredientSql('"Ingredient"."id"'),
        )}::int`.as("recipeCount"),
      })
      .from(ingredient)
      .where(
        and(
          notDeleted(ingredient),
          isNull(ingredient.recipeId),
          or(
            formatSearchTerm(ingredient.name, query),
            formatArraySearchTerm(ingredient.aliases, query),
          ),
        ),
      )
      .limit(limitPerType) as Promise<IngredientSearchResult[]>,

    // Location: search name
    client
      .select({
        id: location.id,
        name: location.name,
        subtitle: location.type,
        entityType: sql<"location">`'location'`.as("entityType"),
        typeHint: location.type,
        imageUrl: sql<string | null>`(
            SELECT i."url" FROM "LocationImage" li
            JOIN "Image" i ON i."id" = li."imageId"
            WHERE li."locationId" = "Location"."id"
            AND li."deletedAt" IS NULL
            AND i."deletedAt" IS NULL
            AND i."contentType" <> ${PDF_CONTENT_TYPE}
            ORDER BY li."createdAt" ASC
            LIMIT 1
          )`.as("imageUrl"),
        createdAt: location.createdAt,
        itemCount: sql<number>`(
            SELECT COUNT(*)::int FROM "InventoryEntry" ie
            WHERE ie."locationId" = "Location"."id"
            AND ie."deletedAt" IS NULL
          )`.as("itemCount"),
        childCount: sql<number>`(
            SELECT COUNT(*)::int FROM "Location" child
            WHERE child."parentId" = "Location"."id"
            AND child."deletedAt" IS NULL
          )`.as("childCount"),
      })
      .from(location)
      .where(
        and(
          notDeleted(location),
          or(
            formatSearchTerm(location.name, query),
            formatArraySearchTerm(location.aliases, query),
          ),
        ),
      )
      .limit(limitPerType) as Promise<LocationSearchResult[]>,

    // Inventory: join with product and location
    client
      .select({
        id: inventoryEntry.id,
        name: product.name,
        subtitle: location.name,
        entityType: sql<"inventory">`'inventory'`.as("entityType"),
        typeHint: product.category,
        imageUrl: sql<string | null>`(
            SELECT i."url" FROM "ProductImage" pi
            JOIN "Image" i ON i."id" = pi."imageId"
            WHERE pi."productId" = "Product"."id"
            AND pi."deletedAt" IS NULL
            AND i."deletedAt" IS NULL
            AND i."contentType" <> ${PDF_CONTENT_TYPE}
            ORDER BY pi."createdAt" ASC
            LIMIT 1
          )`.as("imageUrl"),
        createdAt: inventoryEntry.createdAt,
        amount: inventoryEntry.amount,
      })
      .from(inventoryEntry)
      .innerJoin(product, eq(inventoryEntry.productId, product.id))
      .innerJoin(location, eq(inventoryEntry.locationId, location.id))
      .where(
        and(
          notDeleted(inventoryEntry),
          // Defense-in-depth: inventory writes now reject soft-deleted targets
          // (assertLiveTargets in inventory/helpers.ts), but guard the joined
          // tables here too so a stray pre-existing bad row never surfaces a
          // deleted product/location name. Consistent with the inventory list
          // query in inventory/crud.ts.
          notDeleted(product),
          notDeleted(location),
          or(
            formatSearchTerm(product.name, query),
            formatArraySearchTerm(product.aliases, query),
            formatSearchTerm(location.name, query),
            formatArraySearchTerm(location.aliases, query),
          ),
        ),
      )
      .limit(limitPerType) as Promise<InventorySearchResult[]>,

    // Project: search name, notes
    client
      .select({
        id: project.id,
        name: project.name,
        subtitle: project.kind,
        entityType: sql<"project">`'project'`.as("entityType"),
        typeHint: project.status,
        imageUrl: sql<string | null>`null`.as("imageUrl"),
        createdAt: project.createdAt,
        status: project.status,
        spent: sql<number>`(
            SELECT COALESCE(SUM(${purchase.cost}), 0)::float FROM "Purchase" p
            WHERE p."projectId" = "Project"."id"
            AND p."deletedAt" IS NULL
          )`.as("spent"),
      })
      .from(project)
      .where(
        and(
          notDeleted(project),
          or(
            formatSearchTerm(project.name, query),
            formatSearchTerm(project.notes, query),
          ),
        ),
      )
      .limit(limitPerType) as Promise<ProjectSearchResult[]>,

    // Task: search name, trade; subtitle/projectName from its (live) project
    client
      .select({
        id: task.id,
        name: task.name,
        subtitle: project.name,
        entityType: sql<"task">`'task'`.as("entityType"),
        typeHint: task.trade,
        imageUrl: sql<string | null>`null`.as("imageUrl"),
        createdAt: task.createdAt,
        status: task.status,
        projectName: project.name,
      })
      .from(task)
      .leftJoin(
        project,
        and(eq(task.projectId, project.id), notDeleted(project)),
      )
      .where(
        and(
          notDeleted(task),
          or(
            formatSearchTerm(task.name, query),
            formatSearchTerm(task.trade, query),
          ),
        ),
      )
      .limit(limitPerType) as Promise<TaskSearchResult[]>,

    // Purchase: search name, trade, notes; subtitle/projectName from its (live) project
    client
      .select({
        id: purchase.id,
        name: purchase.name,
        subtitle: project.name,
        entityType: sql<"purchase">`'purchase'`.as("entityType"),
        typeHint: purchase.costType,
        imageUrl: sql<string | null>`null`.as("imageUrl"),
        createdAt: purchase.createdAt,
        cost: purchase.cost,
        projectName: project.name,
      })
      .from(purchase)
      .leftJoin(
        project,
        and(eq(purchase.projectId, project.id), notDeleted(project)),
      )
      .where(
        and(
          notDeleted(purchase),
          or(
            formatSearchTerm(purchase.name, query),
            formatSearchTerm(purchase.trade, query),
            formatSearchTerm(purchase.notes, query),
          ),
        ),
      )
      .limit(limitPerType) as Promise<PurchaseSearchResult[]>,
  ]);

  // Combine all results - TypeScript knows this is SearchResultItem[]
  return [
    ...products,
    ...recipes,
    ...ingredients,
    ...locations,
    ...inventory,
    ...projects,
    ...tasks,
    ...purchases,
  ];
}

interface SearchEntityRef {
  entityType: SearchableEntity;
  entityId: string;
}

export async function hydrateSearchResultsByRefs(
  db: Database,
  refs: SearchEntityRef[],
): Promise<SearchResultItem[]> {
  const client = getDb(db);
  const idsByType = new Map<SearchableEntity, string[]>();
  for (const ref of refs) {
    const ids = idsByType.get(ref.entityType) ?? [];
    ids.push(ref.entityId);
    idsByType.set(ref.entityType, ids);
  }

  const [
    products,
    recipes,
    ingredients,
    locations,
    inventory,
    projects,
    tasks,
    purchases,
  ] = await Promise.all([
    idsByType.get("product")?.length
      ? (client
          .select({
            id: product.id,
            name: product.name,
            subtitle: product.manufacturer,
            entityType: sql<"product">`'product'`.as("entityType"),
            typeHint: product.category,
            imageUrl: sql<string | null>`(
                SELECT i."url" FROM "ProductImage" pi
                JOIN "Image" i ON i."id" = pi."imageId"
                WHERE pi."productId" = "Product"."id"
                AND pi."deletedAt" IS NULL
                AND i."deletedAt" IS NULL
                AND i."contentType" <> ${PDF_CONTENT_TYPE}
                ORDER BY pi."createdAt" ASC
                LIMIT 1
              )`.as("imageUrl"),
            createdAt: product.createdAt,
            price: product.price,
            stockCount: sql<number>`(
                SELECT COUNT(*)::int FROM "InventoryEntry" ie
                WHERE ie."productId" = "Product"."id"
                AND ie."deletedAt" IS NULL
              )`.as("stockCount"),
          })
          .from(product)
          .where(
            and(
              notDeleted(product),
              idIn(product.id, idsByType.get("product")!),
            ),
          ) as Promise<ProductSearchResult[]>)
      : Promise.resolve([]),
    idsByType.get("recipe")?.length
      ? (client
          .select({
            id: recipe.id,
            name: recipe.name,
            subtitle: sql<string | null>`null`.as("subtitle"),
            entityType: sql<"recipe">`'recipe'`.as("entityType"),
            typeHint: sql<string | null>`null`.as("typeHint"),
            imageUrl: sql<string | null>`(
                SELECT i."url" FROM "RecipeImage" ri
                JOIN "Image" i ON i."id" = ri."imageId"
                WHERE ri."recipeId" = "Recipe"."id"
                AND ri."deletedAt" IS NULL
                AND i."deletedAt" IS NULL
                AND i."contentType" <> ${PDF_CONTENT_TYPE}
                ORDER BY ri."createdAt" ASC
                LIMIT 1
              )`.as("imageUrl"),
            createdAt: recipe.createdAt,
            ingredientCount: sql<number>`(
                SELECT COUNT(*)::int FROM "RecipeSectionIngredient" rsi
                JOIN "RecipeSection" rs ON rsi."recipeSectionId" = rs.id AND rs."deletedAt" IS NULL
                WHERE rs."recipeId" = "Recipe"."id" AND rsi."deletedAt" IS NULL
              )`.as("ingredientCount"),
          })
          .from(recipe)
          .where(
            and(notDeleted(recipe), idIn(recipe.id, idsByType.get("recipe")!)),
          ) as Promise<RecipeSearchResult[]>)
      : Promise.resolve([]),
    idsByType.get("ingredient")?.length
      ? (client
          .select({
            id: ingredient.id,
            name: ingredient.name,
            subtitle: sql<string | null>`null`.as("subtitle"),
            entityType: sql<"ingredient">`'ingredient'`.as("entityType"),
            typeHint: sql<string | null>`null`.as("typeHint"),
            imageUrl: sql<string | null>`null`.as("imageUrl"),
            createdAt: ingredient.createdAt,
            recipeCount: sql<number>`${sql.raw(
              liveRecipeCountForIngredientSql('"Ingredient"."id"'),
            )}::int`.as("recipeCount"),
          })
          .from(ingredient)
          .where(
            and(
              notDeleted(ingredient),
              isNull(ingredient.recipeId),
              idIn(ingredient.id, idsByType.get("ingredient")!),
            ),
          ) as Promise<IngredientSearchResult[]>)
      : Promise.resolve([]),
    idsByType.get("location")?.length
      ? (client
          .select({
            id: location.id,
            name: location.name,
            subtitle: location.type,
            entityType: sql<"location">`'location'`.as("entityType"),
            typeHint: location.type,
            imageUrl: sql<string | null>`(
                SELECT i."url" FROM "LocationImage" li
                JOIN "Image" i ON i."id" = li."imageId"
                WHERE li."locationId" = "Location"."id"
                AND li."deletedAt" IS NULL
                AND i."deletedAt" IS NULL
                AND i."contentType" <> ${PDF_CONTENT_TYPE}
                ORDER BY li."createdAt" ASC
                LIMIT 1
              )`.as("imageUrl"),
            createdAt: location.createdAt,
            itemCount: sql<number>`(
                SELECT COUNT(*)::int FROM "InventoryEntry" ie
                WHERE ie."locationId" = "Location"."id"
                AND ie."deletedAt" IS NULL
              )`.as("itemCount"),
            childCount: sql<number>`(
                SELECT COUNT(*)::int FROM "Location" child
                WHERE child."parentId" = "Location"."id"
                AND child."deletedAt" IS NULL
              )`.as("childCount"),
          })
          .from(location)
          .where(
            and(
              notDeleted(location),
              idIn(location.id, idsByType.get("location")!),
            ),
          ) as Promise<LocationSearchResult[]>)
      : Promise.resolve([]),
    idsByType.get("inventory")?.length
      ? (client
          .select({
            id: inventoryEntry.id,
            name: product.name,
            subtitle: location.name,
            entityType: sql<"inventory">`'inventory'`.as("entityType"),
            typeHint: product.category,
            imageUrl: sql<string | null>`(
                SELECT i."url" FROM "ProductImage" pi
                JOIN "Image" i ON i."id" = pi."imageId"
                WHERE pi."productId" = "Product"."id"
                AND pi."deletedAt" IS NULL
                AND i."deletedAt" IS NULL
                AND i."contentType" <> ${PDF_CONTENT_TYPE}
                ORDER BY pi."createdAt" ASC
                LIMIT 1
              )`.as("imageUrl"),
            createdAt: inventoryEntry.createdAt,
            amount: inventoryEntry.amount,
          })
          .from(inventoryEntry)
          .innerJoin(product, eq(inventoryEntry.productId, product.id))
          .innerJoin(location, eq(inventoryEntry.locationId, location.id))
          .where(
            and(
              notDeleted(inventoryEntry),
              notDeleted(product),
              notDeleted(location),
              idIn(inventoryEntry.id, idsByType.get("inventory")!),
            ),
          ) as Promise<InventorySearchResult[]>)
      : Promise.resolve([]),
    idsByType.get("project")?.length
      ? (client
          .select({
            id: project.id,
            name: project.name,
            subtitle: project.kind,
            entityType: sql<"project">`'project'`.as("entityType"),
            typeHint: project.status,
            imageUrl: sql<string | null>`null`.as("imageUrl"),
            createdAt: project.createdAt,
            status: project.status,
            spent: sql<number>`(
                SELECT COALESCE(SUM(${purchase.cost}), 0)::float FROM "Purchase" p
                WHERE p."projectId" = "Project"."id"
                AND p."deletedAt" IS NULL
              )`.as("spent"),
          })
          .from(project)
          .where(
            and(
              notDeleted(project),
              idIn(project.id, idsByType.get("project")!),
            ),
          ) as Promise<ProjectSearchResult[]>)
      : Promise.resolve([]),
    idsByType.get("task")?.length
      ? (client
          .select({
            id: task.id,
            name: task.name,
            subtitle: project.name,
            entityType: sql<"task">`'task'`.as("entityType"),
            typeHint: task.trade,
            imageUrl: sql<string | null>`null`.as("imageUrl"),
            createdAt: task.createdAt,
            status: task.status,
            projectName: project.name,
          })
          .from(task)
          .leftJoin(
            project,
            and(eq(task.projectId, project.id), notDeleted(project)),
          )
          .where(
            and(notDeleted(task), idIn(task.id, idsByType.get("task")!)),
          ) as Promise<TaskSearchResult[]>)
      : Promise.resolve([]),
    idsByType.get("purchase")?.length
      ? (client
          .select({
            id: purchase.id,
            name: purchase.name,
            subtitle: project.name,
            entityType: sql<"purchase">`'purchase'`.as("entityType"),
            typeHint: purchase.costType,
            imageUrl: sql<string | null>`null`.as("imageUrl"),
            createdAt: purchase.createdAt,
            cost: purchase.cost,
            projectName: project.name,
          })
          .from(purchase)
          .leftJoin(
            project,
            and(eq(purchase.projectId, project.id), notDeleted(project)),
          )
          .where(
            and(
              notDeleted(purchase),
              idIn(purchase.id, idsByType.get("purchase")!),
            ),
          ) as Promise<PurchaseSearchResult[]>)
      : Promise.resolve([]),
  ]);

  const byKey = new Map(
    [
      ...products,
      ...recipes,
      ...ingredients,
      ...locations,
      ...inventory,
      ...projects,
      ...tasks,
      ...purchases,
    ].map((item) => [`${item.entityType}:${item.id}`, item] as const),
  );
  return refs.flatMap((ref) => {
    const item = byKey.get(`${ref.entityType}:${ref.entityId}`);
    return item ? [item] : [];
  });
}
