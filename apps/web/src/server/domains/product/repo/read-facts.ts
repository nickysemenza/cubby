import type { ProductId } from "@cubby/schemas/identifiers";
import { isServiceProductCategory } from "@cubby/schemas/product-category-fields";
import { productReadFacts } from "@cubby/schemas/product-read-fields";
import { foodSummary } from "@cubby/usda";
import { and, getTableColumns, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

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
import { loadPrimaryGtins } from "~/server/domains/product/repo/gtin";
import { foodLookupParamFromProduct } from "~/server/domains/product/repo/helpers";
import type { UsdaFoodBatchPort } from "~/server/domains/usda-food/repo/usda-helpers";
import { batchEnrichWithFood } from "~/server/domains/usda-food/repo/usda-helpers";
import type { DerivedCompute } from "~/server/generic/derived/repo/compute";
import { deriveProductQuantitySummary } from "~/server/lib/product-quantity-summary";

import { productFieldResolutions } from "./mappers";
import { ownershipExitExpensePredicate } from "./ownership";
import { loadProductOwnershipEvidenceBatch } from "./ownership-evidence";
import { loadProductPricing } from "./pricing";
import { onHandUnitsSql } from "./quantity-ledger";
import { enrichProductRowsWithQuantityLedger } from "./quantity-ledger";
import { productStockContext } from "./stock-context";

const partsAccountedKitsSql = sql`(SELECT min(floor(COALESCE(${sql.raw(onHandUnitsSql("kac_p"))}, 0) / kac."quantity"))
       FROM "EntityLink" kac
       JOIN "Product" kac_p
         ON kac_p."id" = kac."toEntityId" AND ${notDeleted("kac_p")}
      WHERE kac."fromEntityId" = ${product.id}
        AND ${notDeleted("kac")} AND kac."kind" = 'productComponent')`;

const recordedDisposal = new QueryBuilder()
  .select({ id: expense.productId })
  .from(expense)
  .where(
    and(notDeleted(expense), actualExpense(), ownershipExitExpensePredicate()),
  );

/** The drain evaluates authoritative inputs; page readers only use its publication. */
export const computeProductReadFacts: DerivedCompute = async (db, ids) => {
  if (ids.length === 0) return new Map();
  const rows = await unwrapDb(db)
    .select({
      ...getTableColumns(product),
      accountedKits: sql<
        number | null
      >`${partsAccountedKitsSql}::double precision`,
      recordedDisposal: inArray(product.id, recordedDisposal),
      category: categorySummarySql(sql`${product.categoryId}`),
      categoryStockTracking: categoryStockTrackingSql(
        sql`${product.categoryId}`,
      ),
    })
    .from(product)
    .where(
      and(
        notDeleted(product),
        sql`${product.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
  const pricing = await loadProductPricing(db, rows);
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
              sql`${location.id} = ${inventoryEntry.locationId}`,
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
    const rows = inventories.get(entry.productId) ?? [];
    rows.push({
      amount: { value: Number(entry.amountValue), unit: entry.amountUnit },
    });
    inventories.set(entry.productId, rows);
  }
  return new Map(
    ledgers.map((row) => {
      const price = pricing.get(row.id);
      const ownershipEvidence = ownership.get(row.id);
      if (!price || !ownershipEvidence)
        throw new Error("Product read facts omitted an admitted row");
      const inventory = inventories.get(row.id) ?? [];
      const tracking = productFieldResolutions(row, price).stockTracked?.value;
      const service = isServiceProductCategory(row.category);
      const quantity = deriveProductQuantitySummary(
        inventory,
        row.quantityLedger,
        service,
      );
      const value = productReadFacts.parse({
        workFacts: {
          priced: !service && price.effectivePrice !== null,
          accountedKits: row.accountedKits,
          unknownAcquisition: row.quantityLedger.unknownAcquisitionLines > 0,
          kitAccounting:
            quantity.onHandUnits !== null &&
            quantity.onHandUnits > 0 &&
            row.accountedKits !== null &&
            row.accountedKits > 0 &&
            quantity.onHandUnits + row.accountedKits >
              row.quantityLedger.expectedQuantity,
          ownershipReconciliation:
            row.recordedDisposal &&
            quantity.onHandUnits !== null &&
            quantity.onHandUnits > 0 &&
            row.quantityLedger.expectedQuantity <= 0 &&
            row.quantityLedger.unknownAcquisitionLines === 0,
          unknownQuantityLines:
            row.quantityLedger.unknownAcquisitionLines +
              row.quantityLedger.unknownExitLines >
            0,
        },
        pricing: price,
        ...quantity,
        pickerOnHand:
          service ||
          (inventory.length === 0 && row.quantityLedger.locationCount === 0)
            ? { state: "none" }
            : quantity.onHandUnits === null
              ? { state: "mixed" }
              : { state: "counted", units: quantity.onHandUnits },
        primaryPlacement: row.primaryPlacement,
        ownershipEvidence,
        stockEvidence: {
          inventoryAmounts: inventory.map((entry) => entry.amount),
          stockTracked:
            tracking === true ? true : tracking === false ? false : null,
          service,
        },
        ...productStockContext({
          category: row.category,
          quantityLedger: row.quantityLedger,
          inventoryEntry: inventory,
          stockTracked:
            tracking === true ? true : tracking === false ? false : null,
        }),
      });
      return [row.id, { value }];
    }),
  );
};

/** USDA lookups run in the background with the same canonical lookup precedence. */
export const productFoodCompute =
  (usdaClient: UsdaFoodBatchPort): DerivedCompute =>
  async (db, ids) => {
    if (ids.length === 0) return new Map();
    const products = await unwrapDb(db)
      .select({ id: product.id, fdc_id: product.fdc_id })
      .from(product)
      .where(
        and(
          notDeleted(product),
          sql`${product.id} = ANY(${uuidArrayParam(ids)})`,
        ),
      );
    const gtins = await loadPrimaryGtins(
      db,
      products.map((row) => row.id),
    );
    const rows = await batchEnrichWithFood(
      products.map((row) => ({
        ...row,
        primaryGtin: gtins.get(row.id) ?? null,
      })),
      foodLookupParamFromProduct,
      usdaClient,
    );
    return new Map(
      rows.map((row) => {
        const value = foodSummary.nullable().parse(row.food);
        return [
          row.id,
          {
            value,
            sort: null,
            decision: {
              outcome:
                value === null
                  ? { kind: "empty" as const, reason: "unset" as const }
                  : { kind: "value" as const },
              provenance: { kind: "computed" as const },
              evidence: {
                fdcId: row.fdc_id,
                primaryGtin: row.primaryGtin,
                lookup: foodLookupParamFromProduct(row),
              },
            },
          },
        ];
      }),
    );
  };
