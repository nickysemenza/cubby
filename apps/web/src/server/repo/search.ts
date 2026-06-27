import type {
  IngredientSearchResult,
  InventorySearchResult,
  LocationSearchResult,
  ProductSearchResult,
  RecipeSearchResult,
  SearchResultItem,
} from "@cubby/schemas/search";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import {
  ingredient,
  inventoryEntry,
  location,
  product,
  recipe,
} from "~/server/db/schema";
import { formatSearchTerm, getDb, notDeleted } from "./database-helpers";
import { liveRecipeCountForIngredientSql } from "./recipe";

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
          imageUrl: sql<string | null>`(
            SELECT i."url" FROM "ProductImage" pi
            JOIN "Image" i ON i."id" = pi."imageId"
            WHERE pi."productId" = "Product"."id"
            AND pi."deletedAt" IS NULL
            AND i."deletedAt" IS NULL
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
            formatSearchTerm(ingredient.name, query),
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
          and(notDeleted(location), formatSearchTerm(location.name, query)),
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
              formatSearchTerm(location.name, query),
            ),
          ),
        )
        .limit(limitPerType) as Promise<InventorySearchResult[]>,
    ]);

  // Combine all results - TypeScript knows this is SearchResultItem[]
  return [...products, ...recipes, ...ingredients, ...locations, ...inventory];
}
