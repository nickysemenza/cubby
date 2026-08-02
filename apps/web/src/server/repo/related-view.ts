import type { Entity } from "@cubby/schemas/entity";
import type {
  RelatedBranchInput,
  RelatedBranchOutput,
  RelatedMatchesInput,
  RelatedOptionsInput,
  RelatedOptionsOutput,
  RelatedPreviewGroup,
  RelatedPreviewInput,
  RelatedViewKey,
} from "@cubby/schemas/related-view";
import {
  relatedFilterPrefix,
  relatedViewRegistry,
} from "@cubby/schemas/related-view";
import { and, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";

interface SqlRelatedView {
  sourceTable: string;
  joins: string;
  targetEntity: RelatedPreviewGroup["items"][number]["entity"];
  label: string;
  sort: string;
  sortDirection: "ASC" | "DESC";
}

const named = (
  sourceTable: string,
  joins: string,
  targetEntity: SqlRelatedView["targetEntity"],
  sort = `lower(t."name")`,
) => ({
  sourceTable,
  joins,
  targetEntity,
  label: `t."name"`,
  sort,
  sortDirection: "ASC" as const,
});
const dated = (
  sourceTable: string,
  joins: string,
  targetEntity: SqlRelatedView["targetEntity"],
  label = `t."name"`,
  sort = `t."createdAt"`,
) => ({
  sourceTable,
  joins,
  targetEntity,
  label,
  sort,
  sortDirection: "DESC" as const,
});

/**
 * Server-owned SQL realization of the curated schema registry. All identifiers
 * below are constants; caller data is parameterized separately.
 */
const SQL_RELATED_VIEWS = {
  "product.vendors": named(
    "Product",
    `JOIN "Expense" e ON e."productId" = s."id" AND e."deletedAt" IS NULL JOIN "Purchase" p ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL JOIN "Vendor" t ON t."id" = p."vendorId" AND t."deletedAt" IS NULL`,
    "vendor",
  ),
  "product.expenses": dated(
    "Product",
    `JOIN "Expense" t ON t."productId" = s."id" AND t."deletedAt" IS NULL`,
    "expense",
    `t."name"`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "product.inventory": dated(
    "Product",
    `JOIN "InventoryEntry" t ON t."productId" = s."id" AND t."deletedAt" IS NULL`,
    "inventory",
    `t."shortcode"`,
    `t."createdAt"`,
  ),
  "product.tasks": named(
    "Product",
    `JOIN "Task" t ON t."subjectProductId" = s."id" AND t."deletedAt" IS NULL`,
    "task",
    `format('%s|%s|%s', CASE WHEN t."status" = 'done' THEN 1 ELSE 0 END, COALESCE(t."dueDate"::text, '9999-12-31'), lower(t."name"))`,
  ),
  "recipe.ingredients": named(
    "Recipe",
    `JOIN "RecipeSection" rs ON rs."recipeId" = s."id" AND rs."deletedAt" IS NULL JOIN "RecipeSectionIngredient" rsi ON rsi."recipeSectionId" = rs."id" AND rsi."deletedAt" IS NULL JOIN "Ingredient" t ON t."id" = rsi."ingredientId" AND t."deletedAt" IS NULL`,
    "ingredient",
  ),
  "recipe.meals": dated(
    "Recipe",
    `JOIN "MealRecipe" mr ON mr."recipeId" = s."id" AND mr."deletedAt" IS NULL JOIN "Meal" t ON t."id" = mr."mealId" AND t."deletedAt" IS NULL`,
    "meal",
    `COALESCE(NULLIF(t."name", ''), t."date"::text, t."shortcode")`,
    `t."date"`,
  ),
  "meal.recipes": named(
    "Meal",
    `JOIN "MealRecipe" mr ON mr."mealId" = s."id" AND mr."deletedAt" IS NULL JOIN "Recipe" t ON t."id" = mr."recipeId" AND t."deletedAt" IS NULL`,
    "recipe",
  ),
  "location.ingredients": named(
    "Location",
    `JOIN "InventoryEntry" ie ON ie."locationId" = s."id" AND ie."deletedAt" IS NULL JOIN "Product" p ON p."id" = ie."productId" AND p."deletedAt" IS NULL JOIN "Ingredient" t ON t."id" = p."ingredientId" AND t."deletedAt" IS NULL`,
    "ingredient",
  ),
  "inventory.ingredient": named(
    "InventoryEntry",
    `JOIN "Product" p ON p."id" = s."productId" AND p."deletedAt" IS NULL JOIN "Ingredient" t ON t."id" = p."ingredientId" AND t."deletedAt" IS NULL`,
    "ingredient",
  ),
  "project.blockedBy": named(
    "Project",
    `JOIN "ProjectDependency" pd ON pd."projectId" = s."id" JOIN "Project" t ON t."id" = pd."blockedByProjectId" AND t."deletedAt" IS NULL`,
    "project",
  ),
  "project.tasks": named(
    "Project",
    `JOIN "Task" t ON t."projectId" = s."id" AND t."deletedAt" IS NULL`,
    "task",
    `format('%s|%s|%s', CASE WHEN t."status" = 'done' THEN 1 ELSE 0 END, COALESCE(t."dueDate"::text, '9999-12-31'), lower(t."name"))`,
  ),
  "project.expenses": dated(
    "Project",
    `JOIN "Expense" t ON t."projectId" = s."id" AND t."deletedAt" IS NULL`,
    "expense",
    `t."name"`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "project.taskProducts": named(
    "Project",
    `JOIN "Task" task_rel ON task_rel."projectId" = s."id" AND task_rel."deletedAt" IS NULL JOIN "Product" t ON t."id" = task_rel."subjectProductId" AND t."deletedAt" IS NULL`,
    "product",
  ),
  "project.purchasedProducts": named(
    "Project",
    `JOIN "Expense" e ON e."projectId" = s."id" AND e."deletedAt" IS NULL JOIN "Product" t ON t."id" = e."productId" AND t."deletedAt" IS NULL`,
    "product",
  ),
  "task.blockedBy": named(
    "Task",
    `JOIN "TaskDependency" td ON td."taskId" = s."id" JOIN "Task" t ON t."id" = td."blockedByTaskId" AND t."deletedAt" IS NULL`,
    "task",
    `format('%s|%s|%s', CASE WHEN t."status" = 'done' THEN 1 ELSE 0 END, COALESCE(t."dueDate"::text, '9999-12-31'), lower(t."name"))`,
  ),
  "task.parent": named(
    "Task",
    `JOIN "Task" t ON t."id" = s."parentTaskId" AND t."deletedAt" IS NULL`,
    "task",
    `format('%s|%s|%s', CASE WHEN t."status" = 'done' THEN 1 ELSE 0 END, COALESCE(t."dueDate"::text, '9999-12-31'), lower(t."name"))`,
  ),
  "vendor.expenses": dated(
    "Vendor",
    `JOIN "Purchase" p ON p."vendorId" = s."id" AND p."deletedAt" IS NULL JOIN "Expense" t ON t."purchaseId" = p."id" AND t."deletedAt" IS NULL`,
    "expense",
    `t."name"`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "vendor.purchases": dated(
    "Vendor",
    `JOIN "Purchase" t ON t."vendorId" = s."id" AND t."deletedAt" IS NULL`,
    "purchase",
    `COALESCE(NULLIF(t."orderId", ''), t."shortcode")`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "vendor.products": named(
    "Vendor",
    `JOIN "Purchase" p ON p."vendorId" = s."id" AND p."deletedAt" IS NULL JOIN "Expense" e ON e."purchaseId" = p."id" AND e."deletedAt" IS NULL JOIN "Product" t ON t."id" = e."productId" AND t."deletedAt" IS NULL`,
    "product",
  ),
  "vendor.transactions": dated(
    "Vendor",
    `JOIN "Purchase" p ON p."vendorId" = s."id" AND p."deletedAt" IS NULL JOIN "FinancialTransaction" t ON t."purchaseId" = p."id" AND t."deletedAt" IS NULL`,
    "financialTransaction",
    `COALESCE(NULLIF(t."merchant", ''), NULLIF(t."rawDescription", ''), t."shortcode")`,
    `COALESCE(t."postedDate", t."transactionDate", t."createdAt"::date)`,
  ),
  "purchase.expenses": dated(
    "Purchase",
    `JOIN "Expense" t ON t."purchaseId" = s."id" AND t."deletedAt" IS NULL`,
    "expense",
    `t."name"`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "purchase.transactions": dated(
    "Purchase",
    `JOIN "FinancialTransaction" t ON t."purchaseId" = s."id" AND t."deletedAt" IS NULL`,
    "financialTransaction",
    `COALESCE(NULLIF(t."merchant", ''), NULLIF(t."rawDescription", ''), t."shortcode")`,
    `COALESCE(t."postedDate", t."transactionDate", t."createdAt"::date)`,
  ),
  "purchase.products": named(
    "Purchase",
    `JOIN "Expense" e ON e."purchaseId" = s."id" AND e."deletedAt" IS NULL JOIN "Product" t ON t."id" = e."productId" AND t."deletedAt" IS NULL`,
    "product",
  ),
  "purchase.projects": named(
    "Purchase",
    `JOIN "Expense" e ON e."purchaseId" = s."id" AND e."deletedAt" IS NULL JOIN "Project" t ON t."id" = e."projectId" AND t."deletedAt" IS NULL`,
    "project",
  ),
  "expense.transactions": dated(
    "Expense",
    `JOIN "Purchase" p ON p."id" = s."purchaseId" AND p."deletedAt" IS NULL JOIN "FinancialTransaction" t ON t."purchaseId" = p."id" AND t."deletedAt" IS NULL`,
    "financialTransaction",
    `COALESCE(NULLIF(t."merchant", ''), NULLIF(t."rawDescription", ''), t."shortcode")`,
    `COALESCE(t."postedDate", t."transactionDate", t."createdAt"::date)`,
  ),
  "financialAccount.transactions": dated(
    "FinancialAccount",
    `JOIN "FinancialTransaction" t ON t."accountId" = s."id" AND t."deletedAt" IS NULL`,
    "financialTransaction",
    `COALESCE(NULLIF(t."merchant", ''), NULLIF(t."rawDescription", ''), t."shortcode")`,
    `COALESCE(t."postedDate", t."transactionDate", t."createdAt"::date)`,
  ),
  "financialAccount.purchases": dated(
    "FinancialAccount",
    `JOIN "FinancialTransaction" ft ON ft."accountId" = s."id" AND ft."deletedAt" IS NULL JOIN "Purchase" t ON t."id" = ft."purchaseId" AND t."deletedAt" IS NULL`,
    "purchase",
    `COALESCE(NULLIF(t."orderId", ''), t."shortcode")`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "financialAccount.vendors": named(
    "FinancialAccount",
    `JOIN "FinancialTransaction" ft ON ft."accountId" = s."id" AND ft."deletedAt" IS NULL JOIN "Purchase" p ON p."id" = ft."purchaseId" AND p."deletedAt" IS NULL JOIN "Vendor" t ON t."id" = p."vendorId" AND t."deletedAt" IS NULL`,
    "vendor",
  ),
  "financialTransaction.vendor": named(
    "FinancialTransaction",
    `JOIN "Purchase" p ON p."id" = s."purchaseId" AND p."deletedAt" IS NULL JOIN "Vendor" t ON t."id" = p."vendorId" AND t."deletedAt" IS NULL`,
    "vendor",
  ),
  "financialTransaction.expenses": dated(
    "FinancialTransaction",
    `JOIN "Purchase" p ON p."id" = s."purchaseId" AND p."deletedAt" IS NULL JOIN "Expense" t ON t."purchaseId" = p."id" AND t."deletedAt" IS NULL`,
    "expense",
    `t."name"`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "financialTransaction.products": named(
    "FinancialTransaction",
    `JOIN "Purchase" p ON p."id" = s."purchaseId" AND p."deletedAt" IS NULL JOIN "Expense" e ON e."purchaseId" = p."id" AND e."deletedAt" IS NULL JOIN "Product" t ON t."id" = e."productId" AND t."deletedAt" IS NULL`,
    "product",
  ),
} as const satisfies Record<RelatedViewKey, SqlRelatedView>;

type RawRow = {
  sourceId: string;
  id: string;
  label: string;
  totalCount: number | string;
};

type BranchRawRow = RawRow & { sortValue: string | number | Date | null };

const rowsOf = (result: unknown): RawRow[] => {
  if (Array.isArray(result)) return result as RawRow[];
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: RawRow[] }).rows;
  }
  return [];
};

async function loadOne(
  db: Database,
  relationKey: RelatedViewKey,
  sourceIds: string[],
): Promise<RelatedPreviewGroup[]> {
  const view = SQL_RELATED_VIEWS[relationKey];
  const ids = sql.join(
    sourceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const query = sql`
    WITH related AS (
      SELECT DISTINCT
        s."shortcode" AS "sourceId",
        t."shortcode" AS "id",
        ${sql.raw(view.label)}::text AS "label",
        ${sql.raw(view.sort)} AS "sortValue"
      FROM ${sql.raw(`"${view.sourceTable}"`)} s
      ${sql.raw(view.joins)}
      WHERE s."shortcode" IN (${ids}) AND s."deletedAt" IS NULL
    ), ranked AS (
      SELECT *,
        count(*) OVER (PARTITION BY "sourceId")::int AS "totalCount",
        row_number() OVER (
          PARTITION BY "sourceId"
          ORDER BY "sortValue" ${sql.raw(view.sortDirection)}, "label", "id"
        ) AS rn
      FROM related
    )
    SELECT "sourceId", "id", "label", "totalCount"
    FROM ranked
    WHERE rn <= 3
    ORDER BY "sourceId", rn
  `;
  const rows = rowsOf(await getDb(db).execute(query));
  const grouped = new Map<string, RelatedPreviewGroup>();
  for (const row of rows) {
    const group = grouped.get(row.sourceId) ?? {
      sourceId: row.sourceId,
      relationKey,
      totalCount: Number(row.totalCount),
      items: [],
    };
    group.items.push({
      entity: view.targetEntity,
      id: row.id,
      label: row.label,
    });
    grouped.set(row.sourceId, group);
  }
  return [...grouped.values()];
}

export async function loadRelatedPreviews(
  db: Database,
  input: RelatedPreviewInput,
): Promise<RelatedPreviewGroup[]> {
  const allowed = new Set(
    relatedViewRegistry
      .filter((view) => view.source === input.source)
      .map((view) => view.key),
  );
  const relationKeys = [...new Set(input.relationKeys)].filter((key) =>
    allowed.has(key),
  );
  if (input.sourceIds.length === 0 || relationKeys.length === 0) return [];
  return (
    await Promise.all(
      relationKeys.map((key) =>
        loadOne(db, key as RelatedViewKey, [...new Set(input.sourceIds)]),
      ),
    )
  ).flat();
}

/**
 * Load a single, paginated branch for the relationship outline. This shares
 * the exact SQL realization used by table previews and predicates, so there
 * is no parallel interpretation of a relationship in the UI layer.
 */
export async function loadRelatedBranch(
  db: Database,
  input: RelatedBranchInput,
): Promise<RelatedBranchOutput> {
  const view = SQL_RELATED_VIEWS[input.relationKey];
  const query = sql`
    WITH related AS (
      SELECT DISTINCT
        t."shortcode" AS "id",
        ${sql.raw(view.label)}::text AS "label",
        ${sql.raw(view.sort)} AS "sortValue"
      FROM ${sql.raw(`"${view.sourceTable}"`)} s
      ${sql.raw(view.joins)}
      WHERE s."shortcode" = ${input.sourceId} AND s."deletedAt" IS NULL
    ), ranked AS (
      SELECT *, count(*) OVER ()::int AS "totalCount"
      FROM related
    )
    SELECT "id", "label", "sortValue", "totalCount"
    FROM ranked
    ORDER BY "sortValue" ${sql.raw(view.sortDirection)}, "label", "id"
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;
  const rows = rowsOf(await getDb(db).execute(query)) as BranchRawRow[];
  const totalCount = rows.length ? Number(rows[0]?.totalCount) : 0;
  const consumed = input.offset + rows.length;
  return {
    sourceId: input.sourceId,
    relationKey: input.relationKey,
    totalCount,
    items: rows.map((row) => ({
      entity: view.targetEntity,
      id: row.id,
      label: row.label,
    })),
    nextOffset: consumed < totalCount ? consumed : null,
  };
}

/** Search targets for a relation, including the number of distinct sources. */
export async function loadRelatedOptions(
  db: Database,
  input: RelatedOptionsInput,
): Promise<RelatedOptionsOutput> {
  const view = SQL_RELATED_VIEWS[input.relationKey];
  const search = input.search?.trim();
  const query = sql`
    SELECT
      t."shortcode" AS "id",
      ${sql.raw(view.label)}::text AS "label",
      count(DISTINCT s."id")::int AS "count"
    FROM ${sql.raw(`"${view.sourceTable}"`)} s
    ${sql.raw(view.joins)}
    WHERE s."deletedAt" IS NULL
      ${search ? sql`AND ${sql.raw(view.label)} ILIKE ${`%${search}%`}` : sql``}
    GROUP BY t."shortcode", ${sql.raw(view.label)}
    ORDER BY "label", "id"
    LIMIT ${input.limit}
  `;
  const rows = rowsOf(await getDb(db).execute(query)) as unknown as Array<{
    id: string;
    label: string;
    count: string | number;
  }>;
  return rows.map((row) => ({
    entity: view.targetEntity,
    id: row.id,
    label: row.label,
    count: Number(row.count),
  }));
}

/** Return source shortcodes in the supplied scope that do (or do not) match. */
export async function loadRelatedMatches(
  db: Database,
  input: RelatedMatchesInput,
): Promise<string[]> {
  const definition = relatedViewRegistry.find(
    (view) => view.key === input.relationKey && view.source === input.source,
  );
  if (!definition) return [];
  const view = SQL_RELATED_VIEWS[input.relationKey];
  const sourceIds = [...new Set(input.sourceIds)];
  const targetIds = [...new Set(input.targetIds)];
  const query = sql`
    SELECT root."shortcode" AS "id"
    FROM ${sql.raw(`"${view.sourceTable}"`)} root
    WHERE root."shortcode" IN (${sql.join(
      sourceIds.map((id) => sql`${id}`),
      sql`, `,
    )})
      AND root."deletedAt" IS NULL
      AND ${input.predicate === "none" ? sql`NOT ` : sql``}EXISTS (
        SELECT 1
        FROM ${sql.raw(`"${view.sourceTable}"`)} s
        ${sql.raw(view.joins)}
        WHERE s."id" = root."id"
          AND s."deletedAt" IS NULL
          AND t."shortcode" IN (${sql.join(
            targetIds.map((id) => sql`${id}`),
            sql`, `,
          )})
      )
  `;
  const rows = rowsOf(await getDb(db).execute(query)) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * Server-side predicates for the structured relation trio on an entity list.
 * Repositories append these to their normal where-clause conditions, keeping
 * pagination/counts honest while sharing the exact same curated joins as the
 * preview endpoint.
 */
export function relatedWhereConditions(
  source: Entity,
  filters: Record<string, unknown>,
  sourceId: SQLWrapper,
): SQL[] {
  return relatedViewRegistry
    .filter((view) => view.source === source)
    .flatMap((definition) => {
      const view = SQL_RELATED_VIEWS[definition.key];
      const prefix = relatedFilterPrefix(definition);
      const rawIds = filters[`${prefix}Id`];
      const ids = Array.isArray(rawIds)
        ? rawIds.filter((value): value is string => typeof value === "string")
        : typeof rawIds === "string"
          ? [rawIds]
          : undefined;
      const presence = filters[`${prefix}PresenceFilter`];
      const rawSearch = filters[`${prefix}Search`];
      const search =
        typeof rawSearch === "string" && rawSearch.trim()
          ? rawSearch.trim()
          : undefined;
      if (!ids && presence !== "has" && presence !== "none" && !search) {
        return [];
      }
      const exists = (extra?: SQL) => sql`EXISTS (
        SELECT 1
        FROM ${sql.raw(`"${view.sourceTable}"`)} s
        ${sql.raw(view.joins)}
        WHERE s."id" = ${sourceId}
          AND s."deletedAt" IS NULL
          ${extra ? sql`AND ${extra}` : sql``}
      )`;
      const exact = ids
        ? ids.length === 0
          ? sql`false`
          : exists(
              sql`t."shortcode" IN (${sql.join(
                ids.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
        : undefined;
      const presencePredicate =
        presence === "has"
          ? exists()
          : presence === "none"
            ? sql`NOT ${exists()}`
            : undefined;
      const identity =
        exact && presencePredicate
          ? or(exact, presencePredicate)
          : (exact ?? presencePredicate);
      const name = search
        ? exists(sql`${sql.raw(view.label)} ILIKE ${`%${search}%`}`)
        : undefined;
      const condition = and(identity, name);
      return condition ? [condition] : [];
    });
}
