import type { ProductId } from "@cubby/schemas/identifiers";
import { isServiceProductCategory } from "@cubby/schemas/product-category-fields";
import {
  productStockFacts,
  type ProductStockFacts,
} from "@cubby/schemas/product-read-fields";
import { and, eq, exists, inArray, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { actualExpense } from "~/server/db/computed/expense-aggregate-sql";
import {
  categoryStockTrackingSql,
  categorySummarySql,
} from "~/server/db/computed/product-category-sql";
import {
  databaseForTransaction,
  isTransaction,
  notDeleted,
  unwrapDb,
  uuidArrayParam,
} from "~/server/db/helpers";
import { expense, inventoryEntry, location, product } from "~/server/db/schema";
import { resolveStockTrackingField } from "~/server/domains/inventory/repo/stock-tracking";
import { deriveProductQuantitySummary } from "~/server/domains/product/repo/quantity-summary";
import { loadStoredDerived } from "~/server/generic/derived/repo/read";

import { ownershipExitExpensePredicate } from "./ownership";
import { loadProductOwnershipEvidenceBatch } from "./ownership-evidence";
import { enrichProductRowsWithQuantityLedger } from "./quantity-ledger";
import { productStockContext } from "./stock-context";
import { partsAccountedKitsSql } from "./work-facts-sql";

/**
 * Current stock facts for a bounded page, read from authoritative Expense,
 * Inventory and Location rows so a member's own write shows at once. The
 * list predicates in work-facts-sql.ts are the SQL form of `workFacts`.
 */
export const loadProductStockFacts = async (
  db: Database | DrizzleTransaction,
  ids: readonly ProductId[],
): Promise<Map<ProductId, ProductStockFacts>> => {
  if (ids.length === 0) return new Map();
  // Unlinked disposal Expenses are valid; EXISTS keeps membership boolean.
  const recordedDisposal = unwrapDb(db)
    .select({ id: expense.id })
    .from(expense)
    .where(
      and(
        eq(expense.productId, product.id),
        notDeleted(expense),
        actualExpense(),
        ownershipExitExpensePredicate(),
      ),
    );
  const rows = await unwrapDb(db)
    .select({
      id: product.id,
      stockTracked: product.stockTracked,
      accountedKits: sql<number | null>`${partsAccountedKitsSql(
        sql`${product.id}`,
      )}::double precision`,
      recordedDisposal: exists(recordedDisposal),
      category: categorySummarySql(sql`${product.categoryId}`),
      categoryStockTracking: categoryStockTrackingSql(
        sql`${product.categoryId}`,
      ),
    })
    .from(product)
    // A tombstoned Product's detail still explains its last stock.
    .where(sql`${product.id} = ANY(${uuidArrayParam([...ids])})`);
  // Sequential: a transaction-bound client cannot run statements concurrently.
  const database = isTransaction(db) ? databaseForTransaction(db) : db;
  const ledgers = await enrichProductRowsWithQuantityLedger(database, rows);
  const ownership = await loadProductOwnershipEvidenceBatch(database, rows);
  const entries =
    rows.length === 0
      ? []
      : await unwrapDb(db)
          .select({
            productId: inventoryEntry.productId,
            amountValue: inventoryEntry.amountValue,
            amountUnit: inventoryEntry.amountUnit,
          })
          .from(inventoryEntry)
          .innerJoin(
            location,
            and(
              notDeleted(location),
              eq(location.id, inventoryEntry.locationId),
            ),
          )
          .where(
            and(
              notDeleted(inventoryEntry),
              inArray(
                inventoryEntry.productId,
                rows.map((row) => row.id),
              ),
            ),
          );
  const inventories = new Map<
    ProductId,
    { amount: { value: number; unit: string } }[]
  >();
  for (const entry of entries) {
    const bucket = inventories.get(entry.productId) ?? [];
    bucket.push({
      amount: { value: Number(entry.amountValue), unit: entry.amountUnit },
    });
    inventories.set(entry.productId, bucket);
  }
  return new Map(
    ledgers.map((row) => {
      const ownershipEvidence = ownership.get(row.id);
      if (!ownershipEvidence)
        throw new Error("Product stock facts omitted an admitted row");
      const inventory = inventories.get(row.id) ?? [];
      const tracking = resolveStockTrackingField(
        row.stockTracked,
        row.categoryStockTracking,
        "product decision",
      ).value;
      const stockTracked =
        tracking === true ? true : tracking === false ? false : null;
      const service = isServiceProductCategory(row.category);
      const ledger = row.quantityLedger;
      const quantity = deriveProductQuantitySummary(inventory, ledger, service);
      const value = productStockFacts.parse({
        workFacts: {
          accountedKits: row.accountedKits,
          unknownAcquisition: ledger.unknownAcquisitionLines > 0,
          kitAccounting:
            quantity.onHandUnits !== null &&
            quantity.onHandUnits > 0 &&
            row.accountedKits !== null &&
            row.accountedKits > 0 &&
            quantity.onHandUnits + row.accountedKits > ledger.expectedQuantity,
          ownershipReconciliation:
            row.recordedDisposal &&
            quantity.onHandUnits !== null &&
            quantity.onHandUnits > 0 &&
            ledger.expectedQuantity <= 0 &&
            ledger.unknownAcquisitionLines === 0,
          unknownQuantityLines:
            ledger.unknownAcquisitionLines + ledger.unknownExitLines > 0,
        },
        ...quantity,
        ledgerExpectedQuantity: service ? null : ledger.expectedQuantity,
        pickerOnHand:
          service || (inventory.length === 0 && ledger.locationCount === 0)
            ? { state: "none" }
            : quantity.onHandUnits === null
              ? { state: "mixed" }
              : { state: "counted", units: quantity.onHandUnits },
        primaryPlacement: row.primaryPlacement,
        ownershipEvidence,
        stockEvidence: {
          inventoryAmounts: inventory.map((entry) => entry.amount),
          stockTracked,
          service,
        },
        ...productStockContext({
          category: row.category,
          quantityLedger: ledger,
          inventoryEntry: inventory,
          stockTracked,
        }),
      });
      return [row.id, value];
    }),
  );
};

/** Compact reads (pickers, kit previews, purchase lines) use the same live
 * stock facts as full Product pages; only price comes from its publication. */
export async function loadProductDisplay(
  db: Database,
  ids: readonly ProductId[],
): Promise<{
  stored: Awaited<ReturnType<typeof loadStoredDerived>>;
  facts: Map<
    ProductId,
    { readonly value: ProductStockFacts | null; readonly stale: boolean }
  >;
}> {
  const stored = await loadStoredDerived(db, "product", [...ids], ["price"]);
  const live = await loadProductStockFacts(db, ids);
  const facts = new Map(
    ids.map(
      (id) => [id, { value: live.get(id) ?? null, stale: false }] as const,
    ),
  );
  return { stored, facts };
}
