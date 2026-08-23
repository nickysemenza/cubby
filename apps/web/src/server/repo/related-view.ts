import { type Entity, entityRefKey } from "@cubby/schemas/entity";
import type {
  RelatedBranchInput,
  RelatedBranchOutput,
  RelatedOptionsInput,
  RelatedOptionsOutput,
  RelatedPreviewGroup,
  RelatedPreviewInput,
  RelatedSummaryInput,
  RelatedSummaryOutput,
  RelatedSummaryRelationKey,
  RelatedViewKey,
} from "@cubby/schemas/related-view";
import {
  relatedFilterPrefix,
  relatedViewPath,
  relatedViewRegistry,
} from "@cubby/schemas/related-view";
import { parseShortcode } from "@cubby/shared";
import { and, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { uniq } from "es-toolkit";
import type { Database } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";
import { resolveEntityDisplayImages } from "~/server/repo/entity-display-image";
import { compileTraversal } from "~/server/repo/relatedness/traversal";

interface SqlRelatedView {
  sourceTable: string;
  targetEntity: RelatedPreviewGroup["items"][number]["entity"];
  label: string;
  sort: string;
  sortDirection: "ASC" | "DESC";
}

const named = (
  sourceTable: string,
  targetEntity: SqlRelatedView["targetEntity"],
  sort = `lower(t."name")`,
) => ({
  sourceTable,
  targetEntity,
  label: `t."name"`,
  sort,
  sortDirection: "ASC" as const,
});
const dated = (
  sourceTable: string,
  targetEntity: SqlRelatedView["targetEntity"],
  label = `t."name"`,
  sort = `t."createdAt"`,
) => ({
  sourceTable,
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
  "product.vendors": named("Product", "vendor"),
  "product.projects": named("Product", "project"),
  "product.usedOnProjects": named("Product", "project"),
  "product.purchases": dated(
    "Product",
    "purchase",
    `COALESCE(NULLIF(t."orderId", ''), t."shortcode")`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "product.expenses": dated(
    "Product",
    "expense",
    `t."name"`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  // includes-installed: this is a related-records view keyed off product
  // identity — a fixture must stay listed among "this product's inventory".
  "product.inventory": dated(
    "Product",
    "inventory",
    `t."shortcode"`,
    `t."createdAt"`,
  ),
  "product.wishes": named("Product", "wish"),
  "product.tasks": named(
    "Product",
    "task",
    `format('%s|%s|%s', CASE WHEN t."status" = 'done' THEN 1 ELSE 0 END, COALESCE(t."dueDate"::text, '9999-12-31'), lower(t."name"))`,
  ),
  "recipe.ingredients": named("Recipe", "ingredient"),
  "recipe.meals": dated(
    "Recipe",
    "meal",
    `COALESCE(NULLIF(t."name", ''), t."date"::text, t."shortcode")`,
    `t."date"`,
  ),
  "meal.recipes": named("Meal", "recipe"),
  // includes-installed: identity/relation views, not a browse/count surface
  // — a fixture's related ingredient must stay reachable either direction.
  "location.ingredients": named("Location", "ingredient"),
  "inventory.ingredient": named("InventoryEntry", "ingredient"),
  "project.blockedBy": named("Project", "project"),
  "project.tasks": named(
    "Project",
    "task",
    `format('%s|%s|%s', CASE WHEN t."status" = 'done' THEN 1 ELSE 0 END, COALESCE(t."dueDate"::text, '9999-12-31'), lower(t."name"))`,
  ),
  "project.expenses": dated(
    "Project",
    "expense",
    `t."name"`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "project.taskProducts": named("Project", "product"),
  "project.purchasedProducts": named("Project", "product"),
  "project.usedTools": named("Project", "product"),
  "project.vendors": named("Project", "vendor"),
  "task.blockedBy": named(
    "Task",
    "task",
    `format('%s|%s|%s', CASE WHEN t."status" = 'done' THEN 1 ELSE 0 END, COALESCE(t."dueDate"::text, '9999-12-31'), lower(t."name"))`,
  ),
  "task.parent": named(
    "Task",
    "task",
    `format('%s|%s|%s', CASE WHEN t."status" = 'done' THEN 1 ELSE 0 END, COALESCE(t."dueDate"::text, '9999-12-31'), lower(t."name"))`,
  ),
  "vendor.expenses": dated(
    "Vendor",
    "expense",
    `t."name"`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "vendor.purchases": dated(
    "Vendor",
    "purchase",
    `COALESCE(NULLIF(t."orderId", ''), t."shortcode")`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "vendor.products": named("Vendor", "product"),
  "vendor.projects": named("Vendor", "project"),
  "vendor.transactions": dated(
    "Vendor",
    "financialTransaction",
    `COALESCE(NULLIF(t."merchant", ''), NULLIF(t."rawDescription", ''), t."shortcode")`,
    `COALESCE(t."postedDate", t."transactionDate", t."createdAt"::date)`,
  ),
  "purchase.expenses": dated(
    "Purchase",
    "expense",
    `t."name"`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "purchase.transactions": dated(
    "Purchase",
    "financialTransaction",
    `COALESCE(NULLIF(t."merchant", ''), NULLIF(t."rawDescription", ''), t."shortcode")`,
    `COALESCE(t."postedDate", t."transactionDate", t."createdAt"::date)`,
  ),
  "purchase.products": named("Purchase", "product"),
  "purchase.projects": named("Purchase", "project"),
  "expense.transactions": dated(
    "Expense",
    "financialTransaction",
    `COALESCE(NULLIF(t."merchant", ''), NULLIF(t."rawDescription", ''), t."shortcode")`,
    `COALESCE(t."postedDate", t."transactionDate", t."createdAt"::date)`,
  ),
  "financialAccount.transactions": dated(
    "FinancialAccount",
    "financialTransaction",
    `COALESCE(NULLIF(t."merchant", ''), NULLIF(t."rawDescription", ''), t."shortcode")`,
    `COALESCE(t."postedDate", t."transactionDate", t."createdAt"::date)`,
  ),
  "financialAccount.purchases": dated(
    "FinancialAccount",
    "purchase",
    `COALESCE(NULLIF(t."orderId", ''), t."shortcode")`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "financialAccount.vendors": named("FinancialAccount", "vendor"),
  "financialTransaction.vendor": named("FinancialTransaction", "vendor"),
  "financialTransaction.expenses": dated(
    "FinancialTransaction",
    "expense",
    `t."name"`,
    `COALESCE(t."date"::timestamp, t."createdAt")`,
  ),
  "financialTransaction.products": named("FinancialTransaction", "product"),
  "wish.candidates": named("Wish", "product"),
} as const satisfies Record<RelatedViewKey, SqlRelatedView>;

/**
 * The curated registry supplies presentation only; traversal joins are compiled
 * from its declared graph path with the aliases this repository query expects.
 */
const COMPILED_RELATED_JOINS = Object.fromEntries(
  relatedViewRegistry.map((view) => [
    view.key,
    compileTraversal(view.source, relatedViewPath(view), "related", {
      root: "s",
      leaf: "t",
    }).joins,
  ]),
) as Record<RelatedViewKey, SQL>;

type RawRow = {
  sourceId: string;
  targetEntityId: string;
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

async function loadOneRows(
  db: Database,
  relationKey: RelatedViewKey,
  sourceIds: string[],
): Promise<RawRow[]> {
  const view = SQL_RELATED_VIEWS[relationKey];
  const ids = sql.join(
    sourceIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const query = sql`
    WITH related AS (
      SELECT DISTINCT
        s."shortcode" AS "sourceId",
        t."id"::text AS "targetEntityId",
        t."shortcode" AS "id",
        ${sql.raw(view.label)}::text AS "label",
        ${sql.raw(view.sort)} AS "sortValue"
      FROM ${sql.raw(`"${view.sourceTable}"`)} s
      ${COMPILED_RELATED_JOINS[relationKey]}
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
    SELECT "sourceId", "targetEntityId", "id", "label", "totalCount"
    FROM ranked
    WHERE rn <= 3
    ORDER BY "sourceId", rn
  `;
  return rowsOf(await getDb(db).execute(query));
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
  const relationKeys = uniq(input.relationKeys).filter((key) =>
    allowed.has(key),
  );
  if (input.sourceIds.length === 0 || relationKeys.length === 0) return [];
  const loaded = await Promise.all(
    relationKeys.map(async (key) => ({
      relationKey: key as RelatedViewKey,
      rows: await loadOneRows(db, key as RelatedViewKey, uniq(input.sourceIds)),
    })),
  );
  const displayImages = await resolveEntityDisplayImages(
    db,
    loaded.flatMap(({ relationKey, rows }) => {
      const targetEntity = SQL_RELATED_VIEWS[relationKey].targetEntity;
      return rows.map((row) => ({
        entityType: targetEntity,
        entityId: row.targetEntityId,
      }));
    }),
  );
  return loaded.flatMap(({ relationKey, rows }) => {
    const targetEntity = SQL_RELATED_VIEWS[relationKey].targetEntity;
    const grouped = new Map<string, RelatedPreviewGroup>();
    for (const row of rows) {
      const group = grouped.get(row.sourceId) ?? {
        sourceId: row.sourceId,
        relationKey,
        totalCount: Number(row.totalCount),
        items: [],
      };
      group.items.push({
        entity: targetEntity,
        id: row.id,
        label: row.label,
        displayImage:
          displayImages.get(entityRefKey(targetEntity, row.targetEntityId)) ??
          null,
      });
      grouped.set(row.sourceId, group);
    }
    return [...grouped.values()];
  });
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
        t."id"::text AS "targetEntityId",
        t."shortcode" AS "id",
        ${sql.raw(view.label)}::text AS "label",
        ${sql.raw(view.sort)} AS "sortValue"
      FROM ${sql.raw(`"${view.sourceTable}"`)} s
      ${COMPILED_RELATED_JOINS[input.relationKey]}
      WHERE s."shortcode" = ${input.sourceId} AND s."deletedAt" IS NULL
    ), ranked AS (
      SELECT *, count(*) OVER ()::int AS "totalCount"
      FROM related
    )
    SELECT "targetEntityId", "id", "label", "sortValue", "totalCount"
    FROM ranked
    ORDER BY "sortValue" ${sql.raw(view.sortDirection)}, "label", "id"
    LIMIT ${input.limit} OFFSET ${input.offset}
  `;
  const rows = rowsOf(await getDb(db).execute(query)) as BranchRawRow[];
  const displayImages = await resolveEntityDisplayImages(
    db,
    rows.map((row) => ({
      entityType: view.targetEntity,
      entityId: row.targetEntityId,
    })),
  );
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
      displayImage:
        displayImages.get(
          entityRefKey(view.targetEntity, row.targetEntityId),
        ) ?? null,
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
    ${COMPILED_RELATED_JOINS[input.relationKey]}
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

type SummaryDefinition = {
  targetEntity: "product" | "project" | "vendor";
  targetJoin: string;
  /** Null targets are meaningful only for incomplete purchase/project provenance. */
  targetPresence: "required" | "optional";
  imageTarget: "product" | "project" | "vendor" | null;
};

const SUMMARY_DEFINITIONS: Record<
  RelatedSummaryRelationKey,
  SummaryDefinition
> = {
  "vendor.products": {
    targetEntity: "product",
    targetJoin: `JOIN "Product" t ON t."id" = se."productId" AND t."deletedAt" IS NULL`,
    targetPresence: "required",
    imageTarget: "product",
  },
  "vendor.projects": {
    targetEntity: "project",
    targetJoin: `LEFT JOIN "Project" t ON t."id" = se."projectId" AND t."deletedAt" IS NULL`,
    targetPresence: "optional",
    imageTarget: "project",
  },
  "purchase.projects": {
    targetEntity: "project",
    targetJoin: `LEFT JOIN "Project" t ON t."id" = se."projectId" AND t."deletedAt" IS NULL`,
    targetPresence: "optional",
    imageTarget: "project",
  },
  "project.vendors": {
    targetEntity: "vendor",
    targetJoin: `LEFT JOIN "Vendor" t ON t."id" = se."vendorId" AND t."deletedAt" IS NULL`,
    targetPresence: "optional",
    imageTarget: "vendor",
  },
  "project.purchasedProducts": {
    targetEntity: "product",
    targetJoin: `JOIN "Product" t ON t."id" = se."productId" AND t."deletedAt" IS NULL`,
    targetPresence: "required",
    imageTarget: "product",
  },
  "product.vendors": {
    targetEntity: "vendor",
    targetJoin: `LEFT JOIN "Vendor" t ON t."id" = se."vendorId" AND t."deletedAt" IS NULL`,
    targetPresence: "optional",
    imageTarget: "vendor",
  },
};

/**
 * Expense-backed relationship rollups. The scope is deliberately expressed per
 * supported relation rather than trying to compile arbitrary graph paths into
 * SQL: these tables have money and liveness semantics that a generic join
 * builder cannot safely infer.
 */
export async function loadRelatedSummary(
  db: Database,
  input: RelatedSummaryInput,
): Promise<RelatedSummaryOutput> {
  const definition = SUMMARY_DEFINITIONS[input.relationKey];
  const scope = (() => {
    if (input.relationKey.startsWith("vendor.")) {
      return sql`scoped_expenses AS (
        SELECT e."id" AS "expenseId", e."cost", e."productQuantity", e."future",
          e."date" AS "expenseDate", e."purchaseId", e."projectId", e."productId",
          p."date" AS "purchaseDate", p."vendorId"
        FROM "Vendor" s
        JOIN "Purchase" p ON p."vendorId" = s."id" AND p."deletedAt" IS NULL
        JOIN "Expense" e ON e."purchaseId" = p."id" AND e."deletedAt" IS NULL
        WHERE s."shortcode" = ${input.sourceId} AND s."deletedAt" IS NULL
      )`;
    }
    if (input.relationKey.startsWith("purchase.")) {
      return sql`scoped_expenses AS (
        SELECT e."id" AS "expenseId", e."cost", e."productQuantity", e."future",
          e."date" AS "expenseDate", e."purchaseId", e."projectId", e."productId",
          p."date" AS "purchaseDate", p."vendorId"
        FROM "Purchase" p
        JOIN "Expense" e ON e."purchaseId" = p."id" AND e."deletedAt" IS NULL
        WHERE p."shortcode" = ${input.sourceId} AND p."deletedAt" IS NULL
      )`;
    }
    if (input.relationKey.startsWith("product.")) {
      return sql`scoped_expenses AS (
        SELECT e."id" AS "expenseId", e."cost", e."productQuantity", e."future",
          e."date" AS "expenseDate", e."purchaseId", e."projectId", e."productId",
          p."date" AS "purchaseDate", p."vendorId"
        FROM "Product" s
        JOIN "Expense" e ON e."productId" = s."id" AND e."deletedAt" IS NULL
        LEFT JOIN "Purchase" p ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL
        WHERE s."shortcode" = ${input.sourceId} AND s."deletedAt" IS NULL
          AND (e."purchaseId" IS NULL OR p."id" IS NOT NULL)
      )`;
    }
    if (input.includeSubProjects) {
      return sql`project_scope AS (
        SELECT "id" FROM "Project"
        WHERE "shortcode" = ${input.sourceId} AND "deletedAt" IS NULL
        UNION ALL
        SELECT child."id" FROM "Project" child
        JOIN project_scope parent ON child."parentProjectId" = parent."id"
        WHERE child."deletedAt" IS NULL
      ), scoped_expenses AS (
        SELECT e."id" AS "expenseId", e."cost", e."productQuantity", e."future",
          e."date" AS "expenseDate", e."purchaseId", e."projectId", e."productId",
          p."date" AS "purchaseDate", p."vendorId"
        FROM project_scope scope
        JOIN "Expense" e ON e."projectId" = scope."id" AND e."deletedAt" IS NULL
        LEFT JOIN "Purchase" p ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL
        WHERE e."purchaseId" IS NULL OR p."id" IS NOT NULL
      )`;
    }
    return sql`scoped_expenses AS (
      SELECT e."id" AS "expenseId", e."cost", e."productQuantity", e."future",
        e."date" AS "expenseDate", e."purchaseId", e."projectId", e."productId",
        p."date" AS "purchaseDate", p."vendorId"
      FROM "Project" s
      JOIN "Expense" e ON e."projectId" = s."id" AND e."deletedAt" IS NULL
      LEFT JOIN "Purchase" p ON p."id" = e."purchaseId" AND p."deletedAt" IS NULL
      WHERE s."shortcode" = ${input.sourceId} AND s."deletedAt" IS NULL
        AND (e."purchaseId" IS NULL OR p."id" IS NOT NULL)
    )`;
  })();
  const imageJoin = definition.imageTarget
    ? definition.imageTarget === "vendor"
      ? `LEFT JOIN LATERAL (
        SELECT i."id", i."url", i."filename", i."contentType"
        FROM "Image" i
        WHERE i."id" = t."logoImageId"
          AND i."deletedAt" IS NULL
          AND i."contentType" <> 'application/pdf'
          AND (i."renderStatus" IS NULL OR i."renderStatus" <> 'failed')
          AND (i."storageStatus" IS NULL OR i."storageStatus" NOT IN ('missing', 'metadata_mismatch'))
        LIMIT 1
      ) img ON TRUE`
      : `LEFT JOIN LATERAL (
        SELECT i."id", i."url", i."filename", i."contentType"
        FROM "${definition.imageTarget === "product" ? "ProductImage" : "ProjectImage"}" ti
        JOIN "Image" i ON i."id" = ti."imageId" AND i."deletedAt" IS NULL
        WHERE ti."${definition.imageTarget}Id" = t."id"
          AND ti."deletedAt" IS NULL
          AND i."contentType" <> 'application/pdf'
          AND (i."renderStatus" IS NULL OR i."renderStatus" <> 'failed')
          AND (i."storageStatus" IS NULL OR i."storageStatus" NOT IN ('missing', 'metadata_mismatch'))
        ORDER BY ti."sortOrder", ti."createdAt", ti."id"
        LIMIT 1
      ) img ON TRUE`
    : "";
  const targetValid =
    definition.targetPresence === "required"
      ? sql`true`
      : definition.targetEntity === "project"
        ? sql`(se."projectId" IS NULL OR t."id" IS NOT NULL)`
        : sql`(se."purchaseId" IS NULL OR t."id" IS NOT NULL)`;
  const search = input.search?.trim();
  const sort = input.sort ?? {
    field: "latestActivity" as const,
    direction: "desc" as const,
  };
  const sortColumn = {
    target: `COALESCE("targetLabel", '')`,
    latestActivity: `"latestActivity"`,
    netSpend: `"netSpend"`,
    purchaseCount: `"purchaseCount"`,
    expenseCount: `"expenseCount"`,
    knownAcquiredUnits: `"knownAcquiredUnits"`,
  }[sort.field];
  const imageColumns = definition.imageTarget
    ? sql`img."id"::text AS "imageId", img."url" AS "imageUrl", img."filename" AS "imageFilename", img."contentType" AS "imageContentType"`
    : sql`NULL::text AS "imageId", NULL::text AS "imageUrl", NULL::text AS "imageFilename", NULL::text AS "imageContentType"`;
  const query = sql`
    WITH RECURSIVE ${scope}, targeted AS (
      SELECT se.*, t."shortcode" AS "targetId", t."name" AS "targetLabel", ${imageColumns}
      FROM scoped_expenses se
      ${sql.raw(definition.targetJoin)}
      ${sql.raw(imageJoin)}
      WHERE ${targetValid}
        ${search ? sql`AND t."name" ILIKE ${`%${search}%`}` : sql``}
    ), grouped AS (
      SELECT
        "targetId", "targetLabel", "imageId", "imageUrl", "imageFilename", "imageContentType",
        count(DISTINCT "expenseId")::int AS "expenseCount",
        count(DISTINCT "purchaseId")::int AS "purchaseCount",
        count(DISTINCT "expenseId") FILTER (WHERE "cost" IS NULL)::int AS "unpricedExpenseCount",
        COALESCE(sum("cost"), 0)::float8 AS "netSpend",
        max(COALESCE("purchaseDate", "expenseDate"))::text AS "latestActivity",
        COALESCE(sum("productQuantity") FILTER (WHERE "cost" > 0 AND NOT "future" AND "productQuantity" IS NOT NULL), 0)::double precision AS "knownAcquiredUnits",
        count(DISTINCT "expenseId") FILTER (WHERE "cost" > 0 AND NOT "future" AND "productQuantity" IS NULL)::int AS "unknownAcquisitionQuantityCount"
      FROM targeted
      GROUP BY "targetId", "targetLabel", "imageId", "imageUrl", "imageFilename", "imageContentType"
    ), totals AS (
      SELECT
        count(DISTINCT "expenseId")::int AS "totalExpenseCount",
        count(DISTINCT "purchaseId")::int AS "totalPurchaseCount",
        count(DISTINCT "expenseId") FILTER (WHERE "cost" IS NULL)::int AS "totalUnpricedExpenseCount",
        COALESCE(sum("cost"), 0)::float8 AS "totalNetSpend",
        COALESCE(sum("productQuantity") FILTER (WHERE "cost" > 0 AND NOT "future" AND "productQuantity" IS NOT NULL), 0)::double precision AS "totalKnownAcquiredUnits",
        count(DISTINCT "expenseId") FILTER (WHERE "cost" > 0 AND NOT "future" AND "productQuantity" IS NULL)::int AS "totalUnknownAcquisitionQuantityCount"
      FROM targeted
    ), paged AS (
      SELECT grouped.*, true AS "isPageRow"
      FROM grouped
      ORDER BY ${sql.raw(sortColumn)} ${sql.raw(sort.direction.toUpperCase())} NULLS LAST, "targetLabel", "targetId"
      LIMIT ${input.limit} OFFSET ${input.offset}
    )
    SELECT paged.*, totals.*, (SELECT count(*)::int FROM grouped) AS "count"
    FROM totals LEFT JOIN paged ON TRUE
  `;
  type SummaryRaw = {
    targetId: string | null;
    targetLabel: string | null;
    imageId: string | null;
    imageUrl: string | null;
    imageFilename: string | null;
    imageContentType: string | null;
    expenseCount: number | string;
    purchaseCount: number | string;
    unpricedExpenseCount: number | string;
    netSpend: number | string;
    latestActivity: string | null;
    knownAcquiredUnits: number | string;
    unknownAcquisitionQuantityCount: number | string;
    isPageRow: boolean | null;
    count: number | string;
    totalExpenseCount: number | string;
    totalPurchaseCount: number | string;
    totalUnpricedExpenseCount: number | string;
    totalNetSpend: number | string;
    totalKnownAcquiredUnits: number | string;
    totalUnknownAcquisitionQuantityCount: number | string;
  };
  const rows = rowsOf(
    await getDb(db).execute(query),
  ) as unknown as SummaryRaw[];
  const first = rows[0];
  const zeroTotals = {
    expenseCount: 0,
    purchaseCount: 0,
    unpricedExpenseCount: 0,
    netSpend: 0,
    knownAcquiredUnits: 0,
    unknownAcquisitionQuantityCount: 0,
  };
  const totals = first
    ? {
        expenseCount: Number(first.totalExpenseCount),
        purchaseCount: Number(first.totalPurchaseCount),
        unpricedExpenseCount: Number(first.totalUnpricedExpenseCount),
        netSpend: Number(first.totalNetSpend),
        knownAcquiredUnits: Number(first.totalKnownAcquiredUnits),
        unknownAcquisitionQuantityCount: Number(
          first.totalUnknownAcquisitionQuantityCount,
        ),
      }
    : zeroTotals;
  const count = first ? Number(first.count) : 0;
  const pageRows = rows.filter((row) => row.isPageRow);
  return {
    data: pageRows.map((row) => ({
      target:
        row.targetId && row.targetLabel
          ? {
              entity: definition.targetEntity,
              id: row.targetId,
              label: row.targetLabel,
              image:
                row.imageId &&
                row.imageUrl &&
                row.imageFilename &&
                row.imageContentType
                  ? {
                      id: row.imageId,
                      url: row.imageUrl,
                      filename: row.imageFilename,
                      contentType: row.imageContentType,
                    }
                  : null,
            }
          : null,
      expenseCount: Number(row.expenseCount),
      purchaseCount: Number(row.purchaseCount),
      unpricedExpenseCount: Number(row.unpricedExpenseCount),
      netSpend: Number(row.netSpend),
      latestActivity: row.latestActivity,
      knownAcquiredUnits: Number(row.knownAcquiredUnits),
      unknownAcquisitionQuantityCount: Number(
        row.unknownAcquisitionQuantityCount,
      ),
    })),
    count,
    totals,
    nextOffset:
      input.offset + pageRows.length < count
        ? input.offset + pageRows.length
        : null,
  };
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
        ${COMPILED_RELATED_JOINS[definition.key]}
        WHERE s."id" = ${sourceId}
          AND s."deletedAt" IS NULL
          ${extra ? sql`AND ${extra}` : sql``}
      )`;
      // Compare against the CANONICAL code. Shortcodes are accepted in any
      // casing and with legacy prefixes (`parseShortcode` uppercases and
      // remaps), but the stored column only ever holds the canonical form — so
      // a raw `IN (...)` silently misses `?parentTaskId=tsk-abcd`. A code that
      // doesn't parse at all is kept as-is: it matches nothing, which is the
      // right answer for an unresolvable filter and keeps this predicate's
      // failure direction safe (it ANDs, so it can never widen the query).
      const canonicalIds = ids?.map(
        (id) => parseShortcode(id)?.shortcode ?? id,
      );
      const exact = canonicalIds
        ? canonicalIds.length === 0
          ? sql`false`
          : exists(
              sql`t."shortcode" IN (${sql.join(
                canonicalIds.map((id) => sql`${id}`),
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
