import {
  fieldResolutionSchema,
  fieldResolutionsSchema,
  type FieldResolution,
} from "@cubby/schemas/field-resolution";
import {
  expenseId,
  inventoryId,
  productId,
  recipeId,
  vendorId,
} from "@cubby/schemas/identifiers";
import { recipeYieldSchema } from "@cubby/schemas/recipe-shared";
import { rawExpenseOut } from "@cubby/schemas/work-raw-read";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  effectiveFieldSql,
  effectiveSourceSql,
} from "~/server/db/computed/effective-field";
import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import {
  product as productTable,
  recipe as recipeTable,
  expense as expenseTable,
  inventoryEntry,
  vendor,
} from "~/server/db/retained-tables";
import { expenseSpendingCategoryResolutionSql } from "~/server/domains/expense/repo/expense-category-resolution";
import { serviceProductIdSql } from "~/server/domains/product/repo/service-category";
import { vendorEvidenceFieldResolutionsSql } from "~/server/domains/purchase/repo/purchase-evidence-policy";

const productResetState = z.object({
  id: productId,
  price: z.number().nullable(),
  service: z.boolean(),
});
const recipeResetState = z.object({
  servings: z.number().nullable(),
  yield: recipeYieldSchema.nullable(),
});
const projectTradeResetFact = z.object({
  value: rawExpenseOut.shape.trade,
  source: z.object({ position: z.number().int().nonnegative(), id: z.uuid() }),
});

/** SQL-only facts for selected-record reset previews; domain orchestration stays in the service. */
export async function readVendorResetResolution(
  db: Database,
  internalId: string,
  field: string,
): Promise<FieldResolution | null> {
  const [row] = await repositoryQueries(db)
    .select({
      orderEvidence: vendor.orderEvidence,
      itemizationExpectation: vendor.itemizationExpectation,
    })
    .from(vendor)
    .where(and(eq(vendor.id, vendorId.parse(internalId)), notDeleted(vendor)));
  if (!row) throw new Error("Vendor reset preview record was not found");
  if (row.itemizationExpectation === null) return null;
  const result = await repositoryQueries(db).execute(sql`SELECT
        ${vendorEvidenceFieldResolutionsSql("reset_vendor")} AS resolutions
        FROM (SELECT ${row.orderEvidence}::text AS "orderEvidence", NULL::text AS "itemizationExpectation") reset_vendor`);
  const resolutions = fieldResolutionsSchema.parse(result.rows[0]?.resolutions);
  return fieldResolutionSchema.parse(resolutions[field]);
}

export async function readInventoryResetEntry(
  db: Database,
  internalId: string,
): Promise<
  Pick<
    typeof inventoryEntry.$inferSelect,
    "id" | "productId" | "ownershipMode" | "ownerLedgerPartyId"
  >
> {
  const [entry] = await repositoryQueries(db)
    .select({
      id: inventoryEntry.id,
      productId: inventoryEntry.productId,
      ownershipMode: inventoryEntry.ownershipMode,
      ownerLedgerPartyId: inventoryEntry.ownerLedgerPartyId,
    })
    .from(inventoryEntry)
    .where(
      and(
        eq(inventoryEntry.id, inventoryId.parse(internalId)),
        notDeleted(inventoryEntry),
      ),
    );
  if (!entry) throw new Error("Inventory reset preview record was not found");
  return entry;
}

export async function readExpenseCategoryResetResolution(
  db: Database,
  internalId: string,
): Promise<FieldResolution | null> {
  const [row] = await repositoryQueries(db)
    .select({
      stored: expenseTable.spendingCategoryId,
      resolution: expenseSpendingCategoryResolutionSql(
        "Expense",
        undefined,
        true,
      ),
    })
    .from(expenseTable)
    .where(
      and(
        eq(expenseTable.id, expenseId.parse(internalId)),
        notDeleted(expenseTable),
      ),
    );
  if (!row) throw new Error("Expense reset preview record was not found");
  if (row.stored === null) return null;
  return fieldResolutionSchema.parse(row.resolution);
}

export async function readRecipeResetState(
  db: Database,
  internalId: string,
): Promise<z.output<typeof recipeResetState>> {
  const rows = await repositoryQueries(db)
    .select({ servings: recipeTable.servings, yield: recipeTable.yield })
    .from(recipeTable)
    .where(
      and(
        eq(recipeTable.id, recipeId.parse(internalId)),
        notDeleted(recipeTable),
      ),
    );
  return recipeResetState.parse(rows[0]);
}

export async function readProductResetState(
  db: Database,
  internalId: string,
): Promise<z.output<typeof productResetState>> {
  const rows = await repositoryQueries(db)
    .select({
      id: productTable.id,
      price: productTable.price,
      service: serviceProductIdSql(sql`${productTable.id}`),
    })
    .from(productTable)
    .where(
      and(
        eq(productTable.id, productId.parse(internalId)),
        notDeleted(productTable),
      ),
    );
  return productResetState.parse(rows[0]);
}

export async function readProjectTradeResetFact(
  db: Database,
  id: string,
): Promise<z.output<typeof projectTradeResetFact>> {
  const projectRow = { id: sql`${id}::uuid` };
  const rows = await repositoryQueries(db).execute(sql`SELECT
        ${effectiveFieldSql("project", "defaultTrade", projectRow)} AS value,
        ${effectiveSourceSql("project", "defaultTrade", projectRow)} AS source`);
  return projectTradeResetFact.parse(rows.rows[0]);
}
