import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { OrganizationId } from "~/schemas/identifiers";
import type {
  IngredientSearchResult,
  InventorySearchResult,
  LocationSearchResult,
  ProductSearchResult,
  RecipeSearchResult,
  SearchResultItem,
} from "~/schemas/search";
import type { Database } from "~/server/db";
import {
  ingredient,
  inventoryEntry,
  location,
  product,
  recipe,
} from "~/server/db/schema";
import { getDb } from "./database-helpers";

/**
 * Global search across all entity types using parallel queries.
 * Returns a flat array of results ordered by entity type.
 */
export async function globalSearch(
  db: Database,
  organizationId: OrganizationId,
  query: string,
  limitPerType = 5,
): Promise<SearchResultItem[]> {
  const client = getDb(db);
  const searchPattern = `%${query}%`;

  // Run 5 parallel queries - each returns its discriminated union variant
  const [products, recipes, ingredients, locations, inventory] =
    await Promise.all([
      // Product: search name, manufacturer, upc
      client
        .select({
          id: product.id,
          name: product.name,
          subtitle: product.manufacturer,
          entityType: sql<"product">`'product'`.as("entityType"),
          typeHint: product.category,
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
            eq(product.organizationId, organizationId),
            isNull(product.deletedAt),
            or(
              ilike(product.name, searchPattern),
              ilike(product.manufacturer, searchPattern),
              ilike(product.upc, searchPattern),
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
          ingredientCount: sql<number>`(
            SELECT COUNT(*)::int FROM "RecipeSectionIngredient" rsi
            JOIN "RecipeSection" rs ON rsi."recipeSectionId" = rs.id
            WHERE rs."recipeId" = "Recipe"."id"
          )`.as("ingredientCount"),
        })
        .from(recipe)
        .where(
          and(
            eq(recipe.organizationId, organizationId),
            isNull(recipe.deletedAt),
            ilike(recipe.name, searchPattern),
          ),
        )
        .limit(limitPerType) as Promise<RecipeSearchResult[]>,

      // Ingredient: search name
      client
        .select({
          id: ingredient.id,
          name: ingredient.name,
          subtitle: sql<string | null>`null`.as("subtitle"),
          entityType: sql<"ingredient">`'ingredient'`.as("entityType"),
          typeHint: sql<string | null>`null`.as("typeHint"),
          recipeCount: sql<number>`(
            SELECT COUNT(DISTINCT rs."recipeId")::int FROM "RecipeSectionIngredient" rsi
            JOIN "RecipeSection" rs ON rsi."recipeSectionId" = rs.id
            WHERE rsi."ingredientId" = "Ingredient"."id"
          )`.as("recipeCount"),
        })
        .from(ingredient)
        .where(
          and(
            eq(ingredient.organizationId, organizationId),
            isNull(ingredient.deletedAt),
            ilike(ingredient.name, searchPattern),
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
            eq(location.organizationId, organizationId),
            isNull(location.deletedAt),
            ilike(location.name, searchPattern),
          ),
        )
        .limit(limitPerType) as Promise<LocationSearchResult[]>,

      // Inventory: join with product and location
      client
        .select({
          id: inventoryEntry.id,
          name: product.name,
          subtitle: location.name,
          entityType: sql<"inventory-item">`'inventory-item'`.as("entityType"),
          typeHint: product.category,
          amount: inventoryEntry.amount,
        })
        .from(inventoryEntry)
        .innerJoin(product, eq(inventoryEntry.productId, product.id))
        .innerJoin(location, eq(inventoryEntry.locationId, location.id))
        .where(
          and(
            eq(inventoryEntry.organizationId, organizationId),
            isNull(inventoryEntry.deletedAt),
            or(
              ilike(product.name, searchPattern),
              ilike(location.name, searchPattern),
            ),
          ),
        )
        .limit(limitPerType) as Promise<InventorySearchResult[]>,
    ]);

  // Combine all results - TypeScript knows this is SearchResultItem[]
  return [...products, ...recipes, ...ingredients, ...locations, ...inventory];
}
