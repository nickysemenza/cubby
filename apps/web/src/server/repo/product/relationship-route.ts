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
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
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
  purchaseId: string;
  purchaseCode: string;
  displayLabel: string | null;
  orderId: string | null;
  date: string;
  vendorCode: string | null;
  vendorName: string | null;
  linkAttachedAt: Date | null;
  source: "expense" | "link" | "both";
};

/**
 * A Product purchase is established either by an explicit provenance edge or
 * a live acquisition Expense. Keep the two sources distinct until this fold:
 * a `both` row is meaningful because only the explicit half is detachable.
 */
const mergePurchaseRelations = (rows: readonly PurchaseRelationRow[]) => {
  const merged = new Map<
    string,
    PurchaseRelationRow & { source: "expense" | "link" | "both" }
  >();
  for (const row of rows) {
    const existing = merged.get(row.purchaseId);
    if (!existing) {
      merged.set(row.purchaseId, row);
      continue;
    }
    // Several Expense rows on one Purchase still establish just the one
    // expense-derived edge. `both` means the sparse link and the ledger edge
    // coexist, never merely that a pair happened to have two ledger lines.
    const source = existing.source === row.source ? existing.source : "both";
    merged.set(row.purchaseId, { ...existing, source });
  }
  return [...merged.values()].sort((a, b) => b.date.localeCompare(a.date));
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
    purchaseLinkRows,
    purchaseExpenseRows,
    purchaseLinkCountRows,
    purchaseExpenseCountRows,
    purchaseOverlapCountRows,
    usedProjectRows,
    purchasedProjectRows,
    purchasedProjectCountRows,
    unassignedExpenseCountRows,
    taskRows,
    vendorRows,
    vendorCountRows,
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
    dbc
      .select({
        purchaseId: purchase.id,
        purchaseCode: purchase.shortcode,
        displayLabel: purchase.displayLabel,
        orderId: purchase.orderId,
        date: purchase.date,
        vendorCode: vendor.shortcode,
        vendorName: vendor.name,
        linkAttachedAt: purchaseProduct.createdAt,
        source: sql<"link">`'link'`,
      })
      .from(purchaseProduct)
      .innerJoin(
        purchase,
        and(eq(purchase.id, purchaseProduct.purchaseId), notDeleted(purchase)),
      )
      .leftJoin(vendor, liveVendor)
      .where(
        and(
          eq(purchaseProduct.productId, productId),
          notDeleted(purchaseProduct),
        ),
      )
      .orderBy(desc(purchase.date), asc(purchase.shortcode))
      .limit(PREVIEW_LIMIT),
    dbc
      .selectDistinct({
        purchaseId: purchase.id,
        purchaseCode: purchase.shortcode,
        displayLabel: purchase.displayLabel,
        orderId: purchase.orderId,
        date: purchase.date,
        vendorCode: vendor.shortcode,
        vendorName: vendor.name,
        linkAttachedAt: sql<Date | null>`null`,
        source: sql<"expense">`'expense'`,
      })
      .from(expense)
      .innerJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .leftJoin(vendor, liveVendor)
      .where(expensePairPredicate(eq(expense.productId, productId)))
      .orderBy(desc(purchase.date), asc(purchase.shortcode))
      .limit(PREVIEW_LIMIT),
    dbc
      .select({ count: countDistinct(purchase.id) })
      .from(purchaseProduct)
      .innerJoin(
        purchase,
        and(eq(purchase.id, purchaseProduct.purchaseId), notDeleted(purchase)),
      )
      .where(
        and(
          eq(purchaseProduct.productId, productId),
          notDeleted(purchaseProduct),
        ),
      ),
    dbc
      .select({ count: countDistinct(purchase.id) })
      .from(expense)
      .innerJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .where(expensePairPredicate(eq(expense.productId, productId))),
    dbc
      .select({ count: countDistinct(purchase.id) })
      .from(purchaseProduct)
      .innerJoin(
        purchase,
        and(eq(purchase.id, purchaseProduct.purchaseId), notDeleted(purchase)),
      )
      .innerJoin(
        expense,
        and(
          eq(expense.purchaseId, purchase.id),
          expensePairPredicate(eq(expense.productId, productId)),
        ),
      )
      .where(
        and(
          eq(purchaseProduct.productId, productId),
          notDeleted(purchaseProduct),
        ),
      ),
    dbc
      .select({
        totalCount: sql<number>`count(*) over ()::int`.mapWith(Number),
        id: project.shortcode,
        name: project.name,
        status: project.status,
      })
      .from(projectToolUsage)
      .innerJoin(
        project,
        and(eq(project.id, projectToolUsage.projectId), notDeleted(project)),
      )
      .where(
        and(
          eq(projectToolUsage.productId, productId),
          notDeleted(projectToolUsage),
        ),
      )
      .orderBy(desc(projectToolUsage.createdAt), asc(project.name))
      .limit(PREVIEW_LIMIT),
    dbc
      .selectDistinct({
        id: project.shortcode,
        name: project.name,
        status: project.status,
      })
      .from(expense)
      .innerJoin(project, liveProject)
      .where(
        and(
          expensePairPredicate(eq(expense.productId, productId)),
          isNotNull(expense.projectId),
        ),
      )
      .orderBy(asc(project.name), asc(project.shortcode))
      .limit(PREVIEW_LIMIT),
    dbc
      .select({ count: countDistinct(project.id) })
      .from(expense)
      .innerJoin(project, liveProject)
      .where(
        and(
          expensePairPredicate(eq(expense.productId, productId)),
          isNotNull(expense.projectId),
        ),
      ),
    dbc
      .select({ count: count() })
      .from(expense)
      .where(
        and(
          expensePairPredicate(eq(expense.productId, productId)),
          isNull(expense.projectId),
        ),
      ),
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
    dbc
      .selectDistinct({ id: vendor.shortcode, name: vendor.name })
      .from(expense)
      .innerJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .innerJoin(vendor, liveVendor)
      .where(expensePairPredicate(eq(expense.productId, productId)))
      .orderBy(asc(vendor.name), asc(vendor.shortcode))
      .limit(PREVIEW_LIMIT),
    dbc
      .select({ count: countDistinct(vendor.id) })
      .from(expense)
      .innerJoin(
        purchase,
        and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
      )
      .innerJoin(vendor, liveVendor)
      .where(expensePairPredicate(eq(expense.productId, productId))),
  ]);

  if (!productRow) {
    throw createAppError("PRODUCT_NOT_FOUND", `Product ${productId} not found`);
  }

  const purchases = mergePurchaseRelations([
    ...purchaseLinkRows,
    ...purchaseExpenseRows,
  ]);
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
        count:
          Number(purchaseLinkCountRows[0]?.count ?? 0) +
          Number(purchaseExpenseCountRows[0]?.count ?? 0) -
          Number(purchaseOverlapCountRows[0]?.count ?? 0),
        preview: purchases.slice(0, PREVIEW_LIMIT).map((row) => ({
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
          linkAttachedAt: row.linkAttachedAt,
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
        count: Number(purchasedProjectCountRows[0]?.count ?? 0),
        unassignedExpenseCount: Number(
          unassignedExpenseCountRows[0]?.count ?? 0,
        ),
        preview: purchasedProjectRows.map((row) => ({
          id: parseShortcodeFor("project", row.id),
          name: row.name,
          status: row.status,
        })),
      },
      vendors: {
        count: Number(vendorCountRows[0]?.count ?? 0),
        preview: vendorRows.map((row) => ({
          id: parseShortcodeFor("vendor", row.id),
          name: row.name,
        })),
      },
    },
  };
}
