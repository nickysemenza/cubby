import { PDF_CONTENT_TYPE } from "@cubby/schemas/image";
import {
  type CookbookSearchResult,
  type ExpenseSearchResult,
  type FinancialAccountSearchResult,
  type FinancialTransactionSearchResult,
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
  type VendorSearchResult,
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
  expense,
  financialAccount,
  financialTransaction,
  ingredient,
  inventoryEntry,
  location,
  meal,
  product,
  project,
  purchase,
  recipe,
  task,
  vendor,
} from "~/server/db/schema";
import { formatSearchTerm, getDb, notDeleted } from "./database-helpers";
import { liveRecipeCountForIngredientSql } from "./recipe";

const formatArraySearchTerm = (column: AnyColumn, query: string): SQL =>
  sql`EXISTS (SELECT 1 FROM unnest(${column}) AS alias WHERE alias ILIKE ${`%${query}%`})`;

/**
 * Match an expense's charge — its vendor's name or its order id — as one
 * correlated EXISTS. See the call site for why this is raw `sql` and why both
 * `deletedAt IS NULL` guards matter.
 */
const chargeTextMatch = (query: string): SQL => {
  const term = `%${query}%`;
  return sql`EXISTS (
    SELECT 1 FROM ${purchase} pu
    LEFT JOIN ${vendor} v ON v."id" = pu."vendorId" AND v."deletedAt" IS NULL
    WHERE pu."id" = ${expense.purchaseId}
      AND pu."deletedAt" IS NULL
      AND (pu."orderId" ILIKE ${term} OR v."name" ILIKE ${term})
  )`;
};

const idIn = (column: AnyColumn, ids: string[]): SQL =>
  sql`${column} IN (${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )})`;

type SearchClient = ReturnType<typeof getDb>;
export type InternalSearchResult = SearchResultItem & { entityId: string };

interface EntitySearchQuery {
  lexicalCondition: (query: string) => SQL | undefined;
  idCondition: (ids: string[]) => SQL;
  load: (
    client: SearchClient,
    condition: SQL | undefined,
    limit: number,
  ) => Promise<InternalSearchResult[]>;
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
          entityId: product.id,
          id: product.shortcode,
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
        .limit(limit) as unknown as Promise<
        (ProductSearchResult & { entityId: string })[]
      >,
  },
  recipe: {
    lexicalCondition: (query) => formatSearchTerm(recipe.name, query),
    idCondition: (ids) => idIn(recipe.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          entityId: recipe.id,
          id: recipe.shortcode,
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
        .limit(limit) as unknown as Promise<
        (RecipeSearchResult & { entityId: string })[]
      >,
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
          entityId: ingredient.id,
          id: ingredient.shortcode,
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
        .limit(limit) as unknown as Promise<
        (IngredientSearchResult & { entityId: string })[]
      >,
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
          entityId: cookbook.id,
          id: cookbook.shortcode,
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
        .limit(limit) as unknown as Promise<
        (CookbookSearchResult & { entityId: string })[]
      >,
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
          entityId: location.id,
          id: location.shortcode,
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
        .limit(limit) as unknown as Promise<
        (LocationSearchResult & { entityId: string })[]
      >,
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
          entityId: inventoryEntry.id,
          id: inventoryEntry.shortcode,
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
        .limit(limit) as unknown as Promise<
        (InventorySearchResult & { entityId: string })[]
      >,
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
          entityId: meal.id,
          id: meal.shortcode,
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
        .limit(limit) as unknown as Promise<
        (MealSearchResult & { entityId: string })[]
      >,
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
          entityId: project.id,
          id: project.shortcode,
          name: project.name,
          subtitle: project.kind,
          entityType: sql<"project">`'project'`.as("entityType"),
          typeHint: project.status,
          imageUrl: sql<string | null>`null`.as("imageUrl"),
          createdAt: project.createdAt,
          status: project.status,
          // Hand-qualified `p."cost"`, not an interpolated `${expense.cost}`.
          // Drizzle's `buildSelection` strips the table prefix off a `PgColumn`
          // inside a single-table select field, so the interpolated form emitted a
          // bare `"cost"` that resolved to `p.cost` only because the subquery
          // happens to alias `"Expense"` as `p` — correct by accident. Spelling it
          // out removes the accident. See the long note in repo/purchase.ts for
          // what this trap cost there.
          spent: sql<number>`(
            SELECT COALESCE(SUM(p."cost"), 0)::float FROM "Expense" p
            WHERE p."projectId" = "Project"."id" AND p."deletedAt" IS NULL
          )`.as("spent"),
        })
        .from(project)
        .where(and(notDeleted(project), condition))
        .limit(limit) as unknown as Promise<
        (ProjectSearchResult & { entityId: string })[]
      >,
  },
  task: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(task.name, query),
        formatSearchTerm(task.trade, query),
        formatSearchTerm(product.name, query),
      ),
    idCondition: (ids) => idIn(task.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          entityId: task.id,
          id: task.shortcode,
          name: task.name,
          subtitle: project.name,
          entityType: sql<"task">`'task'`.as("entityType"),
          typeHint: task.trade,
          imageUrl: sql<string | null>`null`.as("imageUrl"),
          createdAt: task.createdAt,
          status: task.status,
          projectName: project.name,
          subjectProductId: task.subjectProductId,
          subjectProductName: product.name,
        })
        .from(task)
        .leftJoin(
          project,
          and(eq(task.projectId, project.id), notDeleted(project)),
        )
        .leftJoin(
          product,
          and(eq(task.subjectProductId, product.id), notDeleted(product)),
        )
        .where(and(notDeleted(task), condition))
        .limit(limit) as unknown as Promise<
        (TaskSearchResult & { entityId: string })[]
      >,
  },
  vendor: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(vendor.name, query),
        formatSearchTerm(vendor.website, query),
        formatSearchTerm(vendor.notes, query),
      ),
    idCondition: (ids) => idIn(vendor.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          entityId: vendor.id,
          id: vendor.shortcode,
          name: vendor.name,
          subtitle: vendor.website,
          entityType: sql<"vendor">`'vendor'`.as("entityType"),
          typeHint: sql<string | null>`null`.as("typeHint"),
          imageUrl: sql<string | null>`null`.as("imageUrl"),
          createdAt: vendor.createdAt,
          purchaseCount: sql<number>`(
            SELECT COUNT(*)::int FROM "Purchase" pu
            WHERE pu."vendorId" = "Vendor"."id" AND pu."deletedAt" IS NULL
          )`.as("purchaseCount"),
          // Spend is always the sum of Expense.cost. Purchase.statedTotal is
          // deliberately absent from this rollup.
          spend: sql<number>`(
            SELECT COALESCE(SUM(e."cost"), 0)::float
            FROM "Purchase" pu
            JOIN "Expense" e ON e."purchaseId" = pu."id" AND e."deletedAt" IS NULL
            WHERE pu."vendorId" = "Vendor"."id" AND pu."deletedAt" IS NULL
          )`.as("spend"),
        })
        .from(vendor)
        .where(and(notDeleted(vendor), condition))
        .limit(limit) as unknown as Promise<
        (VendorSearchResult & { entityId: string })[]
      >,
  },
  purchase: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(purchase.orderId, query),
        formatSearchTerm(purchase.notes, query),
        formatSearchTerm(vendor.name, query),
        formatSearchTerm(vendor.website, query),
        sql`${purchase.date}::text ILIKE ${`%${query}%`}`,
      ),
    idCondition: (ids) => idIn(purchase.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          entityId: purchase.id,
          id: purchase.shortcode,
          name: sql<string>`COALESCE(
            NULLIF(${purchase.orderId}, ''),
            ${vendor.name} || ' · ' || ${purchase.date}::text
          )`.as("name"),
          subtitle: vendor.name,
          entityType: sql<"purchase">`'purchase'`.as("entityType"),
          typeHint: sql<string | null>`null`.as("typeHint"),
          imageUrl: sql<string | null>`null`.as("imageUrl"),
          createdAt: purchase.createdAt,
          orderId: purchase.orderId,
          date: sql<string | null>`${purchase.date}::text`.as("date"),
          expenseCount: sql<number>`(
            SELECT COUNT(*)::int FROM "Expense" e
            WHERE e."purchaseId" = "Purchase"."id" AND e."deletedAt" IS NULL
          )`.as("expenseCount"),
          expenseTotal: sql<number>`(
            SELECT COALESCE(SUM(e."cost"), 0)::float FROM "Expense" e
            WHERE e."purchaseId" = "Purchase"."id" AND e."deletedAt" IS NULL
          )`.as("expenseTotal"),
        })
        .from(purchase)
        .innerJoin(
          vendor,
          and(eq(purchase.vendorId, vendor.id), notDeleted(vendor)),
        )
        .where(and(notDeleted(purchase), condition))
        .limit(limit) as unknown as Promise<
        (PurchaseSearchResult & { entityId: string })[]
      >,
  },
  financialAccount: {
    lexicalCondition: (query) => {
      const term = `%${query}%`;
      return or(
        formatSearchTerm(financialAccount.name, query),
        formatSearchTerm(financialAccount.notes, query),
        sql`${financialAccount.identity}::text ILIKE ${term}`,
        sql`${financialAccount.sourceAliases}::text ILIKE ${term}`,
      );
    },
    idCondition: (ids) => idIn(financialAccount.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          entityId: financialAccount.id,
          id: financialAccount.shortcode,
          name: financialAccount.name,
          subtitle: sql<
            string | null
          >`${financialAccount.identity}->>'kind'`.as("subtitle"),
          entityType: sql<"financialAccount">`'financialAccount'`.as(
            "entityType",
          ),
          typeHint: sql<
            string | null
          >`${financialAccount.identity}->>'kind'`.as("typeHint"),
          imageUrl: sql<string | null>`null`.as("imageUrl"),
          createdAt: financialAccount.createdAt,
          identityKind: sql<
            string | null
          >`${financialAccount.identity}->>'kind'`.as("identityKind"),
          provisional: financialAccount.provisional,
          transactionCount: sql<number>`(
            SELECT COUNT(*)::int FROM "FinancialTransaction" ft
            WHERE ft."accountId" = "FinancialAccount"."id" AND ft."deletedAt" IS NULL
          )`.as("transactionCount"),
        })
        .from(financialAccount)
        .where(and(notDeleted(financialAccount), condition))
        .limit(limit) as unknown as Promise<
        (FinancialAccountSearchResult & { entityId: string })[]
      >,
  },
  financialTransaction: {
    lexicalCondition: (query) => {
      const term = `%${query}%`;
      return or(
        formatSearchTerm(financialTransaction.merchant, query),
        formatSearchTerm(financialTransaction.rawDescription, query),
        formatSearchTerm(financialTransaction.sourceCategory, query),
        formatSearchTerm(financialTransaction.notes, query),
        formatSearchTerm(financialAccount.name, query),
        formatSearchTerm(purchase.orderId, query),
        formatSearchTerm(vendor.name, query),
        sql`${financialTransaction.sourceRefs}::text ILIKE ${term}`,
        sql`${financialTransaction.transactionDate}::text ILIKE ${term}`,
        sql`${financialTransaction.postedDate}::text ILIKE ${term}`,
      );
    },
    idCondition: (ids) => idIn(financialTransaction.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          entityId: financialTransaction.id,
          id: financialTransaction.shortcode,
          name: sql<string>`COALESCE(
            NULLIF(${financialTransaction.merchant}, ''),
            NULLIF(${financialTransaction.rawDescription}, ''),
            ${financialTransaction.kind}
          )`.as("name"),
          subtitle: financialAccount.name,
          entityType: sql<"financialTransaction">`'financialTransaction'`.as(
            "entityType",
          ),
          typeHint: financialTransaction.status,
          imageUrl: sql<string | null>`null`.as("imageUrl"),
          createdAt: financialTransaction.createdAt,
          amount: financialTransaction.amount,
          status: financialTransaction.status,
          kind: financialTransaction.kind,
          accountName: financialAccount.name,
          transactionDate: sql<
            string | null
          >`${financialTransaction.transactionDate}::text`.as(
            "transactionDate",
          ),
        })
        .from(financialTransaction)
        .innerJoin(
          financialAccount,
          and(
            eq(financialTransaction.accountId, financialAccount.id),
            notDeleted(financialAccount),
          ),
        )
        .leftJoin(
          purchase,
          and(
            eq(financialTransaction.purchaseId, purchase.id),
            notDeleted(purchase),
          ),
        )
        .leftJoin(
          vendor,
          and(eq(purchase.vendorId, vendor.id), notDeleted(vendor)),
        )
        .where(and(notDeleted(financialTransaction), condition))
        .limit(limit) as unknown as Promise<
        (FinancialTransactionSearchResult & { entityId: string })[]
      >,
  },
  expense: {
    lexicalCondition: (query) =>
      or(
        formatSearchTerm(expense.name, query),
        formatSearchTerm(expense.trade, query),
        formatSearchTerm(expense.notes, query),
        // Vendor name and order id live on the charge now, so they're reached
        // with a correlated EXISTS rather than two more column predicates. Raw
        // `sql` instead of drizzle's `exists()` because `lexicalCondition` is
        // handed only the query string — no client to build a subquery from.
        //
        // Both `deletedAt IS NULL` guards are load-bearing: an EXISTS is
        // satisfied by soft-deleted rows, so without them an expense would keep
        // matching a deleted charge's vendor (the `findOrphanedProducts` bug
        // class — see the soft-delete section of CLAUDE.md). Guard-exempt only
        // because it's hand-written SQL, not a `notExists(...)` call.
        chargeTextMatch(query),
      ),
    idCondition: (ids) => idIn(expense.id, ids),
    load: (client, condition, limit) =>
      client
        .select({
          entityId: expense.id,
          id: expense.shortcode,
          name: expense.name,
          subtitle: project.name,
          entityType: sql<"expense">`'expense'`.as("entityType"),
          typeHint: expense.costType,
          imageUrl: sql<string | null>`null`.as("imageUrl"),
          createdAt: expense.createdAt,
          cost: expense.cost,
          projectName: project.name,
        })
        .from(expense)
        .leftJoin(
          project,
          and(eq(expense.projectId, project.id), notDeleted(project)),
        )
        .where(and(notDeleted(expense), condition))
        .limit(limit) as unknown as Promise<
        (ExpenseSearchResult & { entityId: string })[]
      >,
  },
} satisfies Record<SearchableEntity, EntitySearchQuery>;

/** Global lexical search across every searchable entity type. */
export async function globalSearch(
  db: Database,
  query: string,
  limitPerType = 5,
  entityTypes: readonly SearchableEntity[] = searchableEntities,
): Promise<InternalSearchResult[]> {
  const client = getDb(db);
  const resultGroups = await Promise.all(
    entityTypes.map((entityType) => {
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
): Promise<InternalSearchResult[]> {
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
      .map((item) => [`${item.entityType}:${item.entityId}`, item] as const),
  );
  return refs.flatMap((ref) => {
    const item = byKey.get(`${ref.entityType}:${ref.entityId}`);
    return item ? [item] : [];
  });
}
