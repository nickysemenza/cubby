/**
 * Product relationship route read model.
 *
 * This is deliberately a fixed Product read, not a wrapper around the generic
 * related-view registry. Purchase provenance, inventory placement, and project
 * use are independent facts whose semantics cannot be inferred from a path.
 * The caller makes one `product.relationshipRoute` operation; this module owns
 * the bounded, canonical navigation data needed by both product surfaces.
 */
import { type ProductId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ProductRelationshipRouteOut } from "@cubby/schemas/product";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import {
  expense,
  inventoryEntry,
  location,
  product,
  project,
  projectToolUsage,
  purchase,
  purchaseProduct,
  task,
  vendor,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { expensePairPredicate } from "~/server/repo/purchase-products";

const PREVIEW_LIMIT = 3;

type PurchaseRelationRow = {
  purchaseCode: string;
  displayLabel: string | null;
  orderId: string | null;
  date: string;
  vendorCode: string | null;
  vendorName: string | null;
  linkAttachedAt: Date | string | null;
  source: "expense" | "link" | "both";
  totalCount: number;
};

type ProjectPreviewRelationRow = {
  kind: "purchased" | "used";
  totalCount: number;
  unassignedExpenseCount: number;
  id: string;
  name: string;
  status: (typeof project.status.enumValues)[number];
};

type ProjectRelationRow =
  | ProjectPreviewRelationRow
  | {
      kind: "meta";
      totalCount: number;
      unassignedExpenseCount: number;
      id: null;
      name: null;
      status: null;
    };

type VendorRelationRow = {
  totalCount: number;
  id: string;
  name: string;
};

const mapPurchaseLinkAttachedAt = (
  value: Date | string | null,
): Date | null => {
  if (value === null) return null;
  const mapped = purchaseProduct.createdAt.mapFromDriverValue(value);
  if (!(mapped instanceof Date)) {
    throw new TypeError("PurchaseProduct.createdAt did not map to a Date");
  }
  return mapped;
};

export async function getProductRelationshipRoute(
  db: Database,
  productId: ProductId,
): Promise<ProductRelationshipRouteOut> {
  const dbc = getDb(db);
  const liveProject = and(
    eq(project.id, expense.projectId),
    notDeleted(project),
  );
  const liveVendor = and(eq(vendor.id, purchase.vendorId), notDeleted(vendor));

  const [
    productRow,
    inventoryRows,
    identityLocationRows,
    expenseRows,
    purchaseResult,
    projectResult,
    taskRows,
    vendorResult,
  ] = await Promise.all([
    dbc.query.product.findFirst({
      where: and(eq(product.id, productId), notDeleted(product)),
      columns: { shortcode: true },
    }),
    dbc
      .select({
        totalCount: sql<number>`count(*) over ()::int`.mapWith(Number),
        stockCount:
          sql<number>`count(*) filter (where ${inventoryEntry.placement} = 'stock') over ()::int`.mapWith(
            Number,
          ),
        installedCount:
          sql<number>`count(*) filter (where ${inventoryEntry.placement} = 'installed') over ()::int`.mapWith(
            Number,
          ),
        id: inventoryEntry.shortcode,
        amount: inventoryEntry.amount,
        placement: inventoryEntry.placement,
        locationId: location.shortcode,
        locationName: location.name,
      })
      .from(inventoryEntry)
      .innerJoin(
        location,
        and(eq(location.id, inventoryEntry.locationId), notDeleted(location)),
      )
      .where(
        and(
          eq(inventoryEntry.productId, productId),
          notDeleted(inventoryEntry),
        ),
      )
      .orderBy(asc(location.name), asc(inventoryEntry.shortcode))
      .limit(PREVIEW_LIMIT),
    dbc
      .select({
        totalCount: sql<number>`count(*) over ()::int`.mapWith(Number),
        id: location.shortcode,
        name: location.name,
      })
      .from(location)
      .where(and(eq(location.productId, productId), notDeleted(location)))
      .orderBy(asc(location.name), asc(location.shortcode))
      .limit(PREVIEW_LIMIT),
    dbc
      .select({
        totalCount: sql<number>`count(*) over ()::int`.mapWith(Number),
        netCost:
          sql<number>`coalesce(sum(${expense.cost}) over (), 0)::double precision`.mapWith(
            Number,
          ),
        id: expense.shortcode,
        name: expense.name,
        cost: expense.cost,
        date: expense.date,
        projectId: project.shortcode,
        projectName: project.name,
        projectStatus: project.status,
      })
      .from(expense)
      .leftJoin(project, liveProject)
      .where(and(eq(expense.productId, productId), notDeleted(expense)))
      .orderBy(desc(expense.date), asc(expense.shortcode))
      .limit(PREVIEW_LIMIT),
    // Preserve the old independent three-row candidate cap for each source
    // before folding them. Duplicate Expenses still mean one purchase; `both`
    // means a detachable link coexists with ledger evidence.
    dbc.execute<PurchaseRelationRow>(sql`
      WITH "linkSources" AS (
        SELECT
          ${purchase.id} AS "purchaseId",
          ${purchase.shortcode} AS "purchaseCode",
          ${purchase.displayLabel} AS "displayLabel",
          ${purchase.orderId} AS "orderId",
          ${purchase.date} AS "date",
          ${vendor.shortcode} AS "vendorCode",
          ${vendor.name} AS "vendorName",
          ${purchaseProduct.createdAt} AS "linkAttachedAt",
          true AS "hasLink",
          false AS "hasExpense",
          row_number() OVER (
            ORDER BY ${purchase.date} DESC, ${purchase.shortcode} ASC
          ) AS "sourceRank"
        FROM ${purchaseProduct}
        INNER JOIN ${purchase}
          ON ${purchase.id} = ${purchaseProduct.purchaseId}
          AND ${notDeleted(purchase)}
        LEFT JOIN ${vendor} ON ${liveVendor}
        WHERE ${and(
          eq(purchaseProduct.productId, productId),
          notDeleted(purchaseProduct),
        )}
      ), "expenseSourceBase" AS (
        SELECT DISTINCT
          ${purchase.id} AS "purchaseId",
          ${purchase.shortcode} AS "purchaseCode",
          ${purchase.displayLabel} AS "displayLabel",
          ${purchase.orderId} AS "orderId",
          ${purchase.date} AS "date",
          ${vendor.shortcode} AS "vendorCode",
          ${vendor.name} AS "vendorName",
          NULL::timestamp AS "linkAttachedAt"
        FROM ${expense}
        INNER JOIN ${purchase}
          ON ${purchase.id} = ${expense.purchaseId}
          AND ${notDeleted(purchase)}
        LEFT JOIN ${vendor} ON ${liveVendor}
        WHERE ${expensePairPredicate(eq(expense.productId, productId))}
      ), "expenseSources" AS (
        SELECT
          *, false AS "hasLink", true AS "hasExpense",
          row_number() OVER (
            ORDER BY "date" DESC, "purchaseCode" ASC
          ) AS "sourceRank"
        FROM "expenseSourceBase"
      ), "allPurchaseSources" AS (
        SELECT * FROM "linkSources"
        UNION ALL
        SELECT * FROM "expenseSources"
      ), "previewSources" AS (
        SELECT * FROM "linkSources" WHERE "sourceRank" <= ${PREVIEW_LIMIT}
        UNION ALL
        SELECT * FROM "expenseSources" WHERE "sourceRank" <= ${PREVIEW_LIMIT}
      ), "purchaseCount" AS (
        SELECT count(DISTINCT "purchaseId")::int AS "totalCount"
        FROM "allPurchaseSources"
      ), "previewPurchases" AS (
        SELECT
          "purchaseId",
          "purchaseCode",
          "displayLabel",
          "orderId",
          "date",
          "vendorCode",
          "vendorName",
          max("linkAttachedAt") AS "linkAttachedAt",
          bool_or("hasLink") AS "linkFirst",
          CASE
            WHEN bool_or("hasLink") AND bool_or("hasExpense") THEN 'both'
            WHEN bool_or("hasLink") THEN 'link'
            ELSE 'expense'
          END AS "source"
        FROM "previewSources"
        GROUP BY
          "purchaseId", "purchaseCode", "displayLabel", "orderId", "date",
          "vendorCode", "vendorName"
      )
      SELECT
        "purchaseCode", "displayLabel", "orderId", "date", "vendorCode",
        "vendorName", "linkAttachedAt", "source",
        "purchaseCount"."totalCount"
      FROM "previewPurchases"
      CROSS JOIN "purchaseCount"
      ORDER BY "date" DESC, "linkFirst" DESC, "purchaseCode" ASC
      LIMIT ${PREVIEW_LIMIT}
    `),
    dbc.execute<ProjectRelationRow>(sql`
      WITH "usedProjects" AS (
        SELECT
          ${project.shortcode} AS "id",
          ${project.name} AS "name",
          ${project.status} AS "status",
          count(*) OVER ()::int AS "totalCount",
          row_number() OVER (
            ORDER BY ${projectToolUsage.createdAt} DESC, ${project.name} ASC,
              ${project.shortcode} ASC
          ) AS "previewOrder"
        FROM ${projectToolUsage}
        INNER JOIN ${project}
          ON ${project.id} = ${projectToolUsage.projectId}
          AND ${notDeleted(project)}
        WHERE ${and(
          eq(projectToolUsage.productId, productId),
          notDeleted(projectToolUsage),
        )}
      ), "purchasedProjectsBase" AS (
        SELECT DISTINCT
          ${project.shortcode} AS "id",
          ${project.name} AS "name",
          ${project.status} AS "status"
        FROM ${expense}
        INNER JOIN ${project}
          ON ${project.id} = ${expense.projectId}
          AND ${notDeleted(project)}
        WHERE ${expensePairPredicate(eq(expense.productId, productId))}
          AND ${expense.projectId} IS NOT NULL
      ), "purchasedProjects" AS (
        SELECT
          "id", "name", "status",
          count(*) OVER ()::int AS "totalCount",
          row_number() OVER (ORDER BY "name" ASC, "id" ASC) AS "previewOrder"
        FROM "purchasedProjectsBase"
      ), "unassignedExpenses" AS (
        SELECT count(*)::int AS "unassignedExpenseCount"
        FROM ${expense}
        WHERE ${expensePairPredicate(eq(expense.productId, productId))}
          AND ${expense.projectId} IS NULL
      )
      SELECT
        'used' AS "kind", "totalCount", 0::int AS "unassignedExpenseCount",
        "id", "name", "status", "previewOrder"
      FROM "usedProjects"
      WHERE "previewOrder" <= ${PREVIEW_LIMIT}

      UNION ALL

      SELECT
        'purchased' AS "kind", "totalCount",
        0::int AS "unassignedExpenseCount", "id", "name", "status",
        "previewOrder"
      FROM "purchasedProjects"
      WHERE "previewOrder" <= ${PREVIEW_LIMIT}

      UNION ALL

      SELECT
        'meta' AS "kind", 0::int AS "totalCount", "unassignedExpenseCount",
        NULL::text AS "id", NULL::text AS "name", NULL::text AS "status",
        0::bigint AS "previewOrder"
      FROM "unassignedExpenses"

      ORDER BY "kind", "previewOrder"
    `),
    dbc
      .select({
        totalCount: sql<number>`count(*) over ()::int`.mapWith(Number),
        openCount:
          sql<number>`count(*) filter (where ${task.status} <> 'done') over ()::int`.mapWith(
            Number,
          ),
        id: task.shortcode,
        name: task.name,
        status: task.status,
        dueDate: task.dueDate,
        projectId: project.shortcode,
        projectName: project.name,
        projectStatus: project.status,
      })
      .from(task)
      .leftJoin(
        project,
        and(eq(project.id, task.projectId), notDeleted(project)),
      )
      .where(and(eq(task.subjectProductId, productId), notDeleted(task)))
      .orderBy(asc(task.status), asc(task.dueDate), asc(task.name))
      .limit(PREVIEW_LIMIT),
    dbc.execute<VendorRelationRow>(sql`
      WITH "productVendors" AS (
        SELECT ${vendor.shortcode} AS "id", ${vendor.name} AS "name"
        FROM ${expense}
        INNER JOIN ${purchase}
          ON ${purchase.id} = ${expense.purchaseId}
          AND ${notDeleted(purchase)}
        INNER JOIN ${vendor} ON ${liveVendor}
        WHERE ${expensePairPredicate(eq(expense.productId, productId))}
        GROUP BY ${vendor.id}, ${vendor.shortcode}, ${vendor.name}
      )
      SELECT count(*) OVER ()::int AS "totalCount", "id", "name"
      FROM "productVendors"
      ORDER BY "name" ASC, "id" ASC
      LIMIT ${PREVIEW_LIMIT}
    `),
  ]);

  if (!productRow) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${productId} not found`);
  }

  const purchaseRows = purchaseResult.rows as unknown as PurchaseRelationRow[];
  const projectRows = projectResult.rows as unknown as ProjectRelationRow[];
  const usedProjectRows = projectRows.filter(
    (row): row is ProjectPreviewRelationRow => row.kind === "used",
  );
  const purchasedProjectRows = projectRows.filter(
    (row): row is ProjectPreviewRelationRow => row.kind === "purchased",
  );
  const projectMeta = projectRows.find((row) => row.kind === "meta");
  const vendorRows = vendorResult.rows as unknown as VendorRelationRow[];
  const inventory = inventoryRows.map((row) => ({
    id: parseShortcodeFor("inventory", row.id),
    amount: row.amount,
    placement: row.placement,
    location: {
      id: parseShortcodeFor("location", row.locationId),
      name: row.locationName,
    },
  }));
  const expenses = expenseRows.map((row) => ({
    id: parseShortcodeFor("expense", row.id),
    name: row.name,
    cost: row.cost,
    date: row.date,
    project:
      row.projectId && row.projectName && row.projectStatus
        ? {
            id: parseShortcodeFor("project", row.projectId),
            name: row.projectName,
            status: row.projectStatus,
          }
        : null,
  }));
  const tasks = taskRows.map((row) => ({
    id: parseShortcodeFor("task", row.id),
    name: row.name,
    status: row.status,
    dueDate: row.dueDate,
    project:
      row.projectId && row.projectName && row.projectStatus
        ? {
            id: parseShortcodeFor("project", row.projectId),
            name: row.projectName,
            status: row.projectStatus,
          }
        : null,
  }));

  return {
    productId: parseShortcodeFor("product", productRow.shortcode),
    direct: {
      inventory: {
        count: inventoryRows[0]?.totalCount ?? 0,
        stockCount: inventoryRows[0]?.stockCount ?? 0,
        installedCount: inventoryRows[0]?.installedCount ?? 0,
        preview: inventory,
      },
      identityLocations: {
        count: identityLocationRows[0]?.totalCount ?? 0,
        preview: identityLocationRows.map((row) => ({
          id: parseShortcodeFor("location", row.id),
          name: row.name,
        })),
      },
      expenses: {
        count: expenseRows[0]?.totalCount ?? 0,
        netCost: expenseRows[0]?.netCost ?? 0,
        preview: expenses,
      },
      purchases: {
        count: purchaseRows[0]?.totalCount ?? 0,
        preview: purchaseRows.map((row) => ({
          id: parseShortcodeFor("purchase", row.purchaseCode),
          displayLabel: row.displayLabel,
          orderId: row.orderId,
          date: row.date,
          vendor:
            row.vendorCode && row.vendorName
              ? {
                  id: parseShortcodeFor("vendor", row.vendorCode),
                  name: row.vendorName,
                }
              : null,
          source: row.source,
          linkAttachedAt: mapPurchaseLinkAttachedAt(row.linkAttachedAt),
        })),
      },
      usedOnProjects: {
        count: usedProjectRows[0]?.totalCount ?? 0,
        preview: usedProjectRows.map((row) => ({
          id: parseShortcodeFor("project", row.id),
          name: row.name,
          status: row.status,
        })),
      },
      tasks: {
        count: taskRows[0]?.totalCount ?? 0,
        openCount: taskRows[0]?.openCount ?? 0,
        preview: tasks,
      },
    },
    derived: {
      purchasedForProjects: {
        count: purchasedProjectRows[0]?.totalCount ?? 0,
        unassignedExpenseCount: projectMeta?.unassignedExpenseCount ?? 0,
        preview: purchasedProjectRows.map((row) => ({
          id: parseShortcodeFor("project", row.id),
          name: row.name,
          status: row.status,
        })),
      },
      vendors: {
        count: vendorRows[0]?.totalCount ?? 0,
        preview: vendorRows.map((row) => ({
          id: parseShortcodeFor("vendor", row.id),
          name: row.name,
        })),
      },
    },
  };
}
