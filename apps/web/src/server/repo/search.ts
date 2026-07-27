import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import {
  type CookbookSearchResult,
  type IngredientSearchResult,
  type InventorySearchResult,
  type LocationSearchResult,
  type MealSearchResult,
  type ProductSearchResult,
  type ProjectSearchResult,
  type PurchaseSearchResult,
  type RecipeSearchResult,
  type SearchableEntity,
  type SearchResultItem,
  searchableEntities,
  type TaskSearchResult,
} from "@cubby/schemas/search";
import {
  type AnyColumn,
  and,
  eq,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  cookbook,
  ingredient,
  inventoryEntry,
  location,
  meal,
  product,
  project,
  purchase,
  recipe,
  task,
} from "~/server/db/schema";
import { formatSearchTerm, getDb, notDeleted } from "./database-helpers";
import { liveRecipeCountForIngredientSql } from "./recipe";

const formatArraySearchTerm = (column: AnyColumn, query: string): SQL =>
  sql`EXISTS (SELECT 1 FROM unnest(${column}) AS alias WHERE alias ILIKE ${`%${query}%`})`;

const idIn = (column: AnyColumn, ids: string[]): SQL =>
  sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;

type SearchClient = ReturnType<typeof getDb>;

interface EntitySearchQuery {
  lexicalCondition: (query: string) => SQL | undefined;
  idCondition: (ids: string[]) => SQL;
  load: (
    client: SearchClient,
    condition: SQL | undefined,
    limit: number,
  ) => Promise<SearchResultItem[]>;
}

const imageUrl = (
  joinTable: "ProductImage" | "RecipeImage" | "LocationImage",
  ownerColumn: string,
): SQL<string | null> =>
  sql`(
    SELECT i."url" FROM ${sql.raw(`"${joinTable}"`)} relation
    JOIN "Image" i ON i."id" = relation."imageId"
    WHERE ${sql.raw(`relation."${ownerColumn}"`)} = ${sql.raw(`"${joinTable.replace("Image", "")}"."id"`)}
    AND relation."deletedAt" IS NULL
    AND i."deletedAt" IS NULL
    AND i."contentType" <> ${PDF_CONTENT_TYPE}
    ORDER BY relation."createdAt" ASC
    LIMIT 1
  )`;

const searchQueries = {
  product: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(product.name, query),
        formatArraySearchTerm(product.aliases, query),
        formatSearchTerm(product.manufacturer, query),
        formatSearchTerm(product.upc, query),
      ),
    idCondition: (ids) => idIn(product.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          id: product.id,
          name: product.name,
          subtitle: product.manufacturer,
          entityType: sql<"product">`'product'`.as("entityType"),
          typeHint: product.category,
          imageUrl: imageUrl("ProductImage", "productId").as("imageUrl"),
          createdAt: product.createdAt,
          price: product.price,
          stockCount: sql<number>`(
            SELECT COUNT(*)::int FROM "InventoryEntry" ie
            WHERE ie."productId" = "Product"."id" AND ie."deletedAt" IS NULL
          )`.as("stockCount"),
        })
        .from(product)
        .where(and(notDeleted(product), condition))
        .limit(limit) as Promise<ProductSearchResult[]>,
  },
  recipe: {
    lexicalCondition: (query) => formatSearchTerm(recipe.name, query),
    idCondition: (ids) => idIn(recipe.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          id: recipe.id,
          name: recipe.name,
          subtitle: sql<string | null>`null`.as("subtitle"),
          entityType: sql<"recipe">`'recipe'`.as("entityType"),
          typeHint: sql<string | null>`null`.as("typeHint"),
          imageUrl: imageUrl("RecipeImage", "recipeId").as("imageUrl"),
          createdAt: recipe.createdAt,
          ingredientCount: sql<number>`(
            SELECT COUNT(*)::int FROM "RecipeSectionIngredient" rsi
            JOIN "RecipeSection" rs ON rsi."recipeSectionId" = rs.id AND rs."deletedAt" IS NULL
            WHERE rs."recipeId" = "Recipe"."id" AND rsi."deletedAt" IS NULL
          )`.as("ingredientCount"),
        })
        .from(recipe)
        .where(and(notDeleted(recipe), condition))
        .limit(limit) as Promise<RecipeSearchResult[]>,
  },
  ingredient: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(ingredient.name, query),
        formatArraySearchTerm(ingredient.aliases, query),
      ),
    idCondition: (ids) => idIn(ingredient.id, ids),
    load: (client, condition, limit) =>
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
          and(notDeleted(ingredient), isNull(ingredient.recipeId), condition),
        )
        .limit(limit) as Promise<IngredientSearchResult[]>,
  },
  cookbook: {
    // Author/subjects are text[] (OPF metadata), so they match through the same
    // unnest-ILIKE the alias arrays use.
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(cookbook.name, query),
        formatArraySearchTerm(cookbook.author, query),
        formatArraySearchTerm(cookbook.subjects, query),
      ),
    idCondition: (ids) => idIn(cookbook.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          id: cookbook.id,
          name: cookbook.name,
          // Authors read as the byline; empty array ⇒ no subtitle.
          subtitle: sql<
            string | null
          >`NULLIF(array_to_string(${cookbook.author}, ', '), '')`.as(
            "subtitle",
          ),
          entityType: sql<"cookbook">`'cookbook'`.as("entityType"),
          typeHint: sql<string | null>`null`.as("typeHint"),
          // The cover is a direct FK (coverImageId), not a join table, so this
          // can't reuse the imageUrl() join-table helper.
          imageUrl: sql<string | null>`(
            SELECT i."url" FROM "Image" i
            WHERE i."id" = "Cookbook"."coverImageId"
            AND i."deletedAt" IS NULL
            AND i."contentType" <> ${PDF_CONTENT_TYPE}
          )`.as("imageUrl"),
          createdAt: cookbook.createdAt,
          recipeCount: sql<number>`(
            SELECT COUNT(*)::int FROM "Recipe" r
            WHERE r."cookbookId" = "Cookbook"."id" AND r."deletedAt" IS NULL
          )`.as("recipeCount"),
          authors: cookbook.author,
        })
        .from(cookbook)
        .where(and(notDeleted(cookbook), condition))
        .limit(limit) as Promise<CookbookSearchResult[]>,
  },
  location: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(location.name, query),
        formatArraySearchTerm(location.aliases, query),
      ),
    idCondition: (ids) => idIn(location.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          id: location.id,
          name: location.name,
          subtitle: location.type,
          entityType: sql<"location">`'location'`.as("entityType"),
          typeHint: location.type,
          imageUrl: imageUrl("LocationImage", "locationId").as("imageUrl"),
          createdAt: location.createdAt,
          itemCount: sql<number>`(
            SELECT COUNT(*)::int FROM "InventoryEntry" ie
            WHERE ie."locationId" = "Location"."id" AND ie."deletedAt" IS NULL
          )`.as("itemCount"),
          childCount: sql<number>`(
            SELECT COUNT(*)::int FROM "Location" child
            WHERE child."parentId" = "Location"."id" AND child."deletedAt" IS NULL
          )`.as("childCount"),
        })
        .from(location)
        .where(and(notDeleted(location), condition))
        .limit(limit) as Promise<LocationSearchResult[]>,
  },
  inventory: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(product.name, query),
        formatArraySearchTerm(product.aliases, query),
        formatSearchTerm(location.name, query),
        formatArraySearchTerm(location.aliases, query),
      ),
    idCondition: (ids) => idIn(inventoryEntry.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          id: inventoryEntry.id,
          name: product.name,
          subtitle: location.name,
          entityType: sql<"inventory">`'inventory'`.as("entityType"),
          typeHint: product.category,
          imageUrl: imageUrl("ProductImage", "productId").as("imageUrl"),
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
            condition,
          ),
        )
        .limit(limit) as Promise<InventorySearchResult[]>,
  },
  meal: {
    // A meal is often unnamed, so the date string and the planned recipes'
    // names are first-class match surfaces alongside the optional name.
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(meal.name, query),
        sql`${meal.date}::text ILIKE ${`%${query}%`}`,
        sql`EXISTS (
          SELECT 1 FROM "MealRecipe" mr
          JOIN "Recipe" r ON r."id" = mr."recipeId" AND r."deletedAt" IS NULL
          WHERE mr."mealId" = "Meal"."id" AND mr."deletedAt" IS NULL
          AND r."name" ILIKE ${`%${query}%`}
        )`,
      ),
    idCondition: (ids) => idIn(meal.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          // Meal.name is nullable; the date is the fallback display name (it is
          // how the calendar labels an unnamed meal).
          id: meal.id,
          name: sql<string>`COALESCE(NULLIF(${meal.name}, ''), ${meal.date}::text)`.as(
            "name",
          ),
          subtitle: sql<string | null>`${meal.date}::text`.as("subtitle"),
          entityType: sql<"meal">`'meal'`.as("entityType"),
          typeHint: sql<string | null>`null`.as("typeHint"),
          imageUrl: sql<string | null>`null`.as("imageUrl"),
          createdAt: meal.createdAt,
          date: sql<string | null>`${meal.date}::text`.as("date"),
          // Joins Recipe: deleting a recipe soft-deletes the recipe but leaves
          // its MealRecipe rows, so counting the join alone would report
          // recipes the meal no longer shows (or embeds).
          recipeCount: sql<number>`(
            SELECT COUNT(*)::int FROM "MealRecipe" mr
            JOIN "Recipe" r ON r."id" = mr."recipeId" AND r."deletedAt" IS NULL
            WHERE mr."mealId" = "Meal"."id" AND mr."deletedAt" IS NULL
          )`.as("recipeCount"),
        })
        .from(meal)
        .where(and(notDeleted(meal), condition))
        .limit(limit) as Promise<MealSearchResult[]>,
  },
  project: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(project.name, query),
        formatSearchTerm(project.notes, query),
      ),
    idCondition: (ids) => idIn(project.id, ids),
    load: (client, condition, limit) =>
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
            WHERE p."projectId" = "Project"."id" AND p."deletedAt" IS NULL
          )`.as("spent"),
        })
        .from(project)
        .where(and(notDeleted(project), condition))
        .limit(limit) as Promise<ProjectSearchResult[]>,
  },
  task: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(task.name, query),
        formatSearchTerm(task.trade, query),
      ),
    idCondition: (ids) => idIn(task.id, ids),
    load: (client, condition, limit) =>
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
        .where(and(notDeleted(task), condition))
        .limit(limit) as Promise<TaskSearchResult[]>,
  },
  purchase: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(purchase.name, query),
        formatSearchTerm(purchase.trade, query),
        formatSearchTerm(purchase.notes, query),
      ),
    idCondition: (ids) => idIn(purchase.id, ids),
    load: (client, condition, limit) =>
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
        .where(and(notDeleted(purchase), condition))
        .limit(limit) as Promise<PurchaseSearchResult[]>,
  },
} satisfies Record<SearchableEntity, EntitySearchQuery>;

/** Global lexical search across every searchable entity type. */
export async function globalSearch(
  db: Database,
  query: string,
  limitPerType = 5,
): Promise<SearchResultItem[]> {
  const client = getDb(db);
  const resultGroups = await Promise.all(
    searchableEntities.map((entityType) => {
      const entityQuery = searchQueries[entityType];
      return entityQuery.load(
        client,
        entityQuery.lexicalCondition(query),
        limitPerType,
      );
    }),
  );
  return resultGroups.flat();
}

interface SearchEntityRef {
  entityType: SearchableEntity;
  entityId: string;
}

/** Hydrate semantic references through the same projections used by lexical search. */
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

  const resultGroups = await Promise.all(
    searchableEntities.map((entityType) => {
      const ids = idsByType.get(entityType) ?? [];
      const entityQuery = searchQueries[entityType];
      return ids.length
        ? entityQuery.load(client, entityQuery.idCondition(ids), ids.length)
        : Promise.resolve([]);
    }),
  );
  const byKey = new Map(
    resultGroups
      .flat()
      .map((item) => [`${item.entityType}:${item.id}`, item] as const),
  );
  return refs.flatMap((ref) => {
    const item = byKey.get(`${ref.entityType}:${ref.entityId}`);
    return item ? [item] : [];
  });
}
