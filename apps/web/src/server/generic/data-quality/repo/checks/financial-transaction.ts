import { and, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { quotedTable } from "~/server/db/helpers/related";
import { financialTransaction } from "~/server/db/schema";
import { allocationIntegrityDefectSql } from "~/server/domains/financial-transaction/repo/financial-allocation-integrity";
import {
  financialTransactionBookingSql,
  financialTransactionCoverageAxisSql,
  financialTransactionItemizationExpectationSql,
  financialTransactionRequiresBookingSql,
} from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
const FINANCIAL_TRANSACTION_QUALITY_RULES_VERSION = 2;
type FinancialTransactionQualityRecord = Awaited<
  ReturnType<typeof loadFinancialTransactionQualityRecords>
>[number];
const observed = qualityCheck.observed<FinancialTransactionQualityRecord>;
const when = qualityCheck.when<FinancialTransactionQualityRecord>;
const incomplete = (value: string) =>
  value === "missing" || value === "partial";

export const financialTransactionChecks = defineStoredEntityChecks({
  entity: "financialTransaction",
  table: financialTransaction,
  rulesVersion: FINANCIAL_TRANSACTION_QUALITY_RULES_VERSION,
  load: loadFinancialTransactionQualityRecords,
  checks: {
    financialtransaction_display_image: qualityCheck.hasImage,
    financial_transaction_allocation_integrity: observed(
      (r) => !r.allocationDefect,
    ),
    financial_transaction_classification: when(
      (r) => r.status !== "void",
      observed((r) => r.kind !== "other"),
    ),
    financial_transaction_allocation: when(
      (r) => r.requiresBooking,
      observed((r) => r.hasAllocation),
    ),
    financial_transaction_merchant: when(
      (r) => r.requiresBooking,
      qualityCheck.required("merchant"),
    ),
    financial_transaction_itemization_expectation: when(
      (r) => r.requiresBooking,
      observed((r) => r.expectation !== "unknown"),
    ),
    financial_transaction_booking: when(
      (r) => r.requiresBooking,
      observed((r) => !incomplete(r.booking)),
    ),
    financial_transaction_itemization: when(
      (r) => r.requiresBooking && r.expectation === "required",
      observed((r) => !incomplete(r.itemization)),
    ),
    financial_transaction_products: when(
      (r) =>
        r.requiresBooking &&
        (incomplete(r.products) || r.products === "present"),
      observed((r) => !incomplete(r.products)),
    ),
  },
});

async function loadFinancialTransactionQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  // The domain owners retain signed allocation and mixed Purchase policy semantics.
  // These inputs are read for this ID page only; list and queue reads use stored rows.
  return unwrapDb(db)
    .select({
      id: financialTransaction.id,
      shortcode: financialTransaction.shortcode,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("financialTransaction", sql`${sql.identifier("FinancialTransaction")}.${sql.identifier("id")}`)}`,
      status: financialTransaction.status,
      kind: financialTransaction.kind,
      merchant: financialTransaction.merchant,
      allocationDefect: sql<boolean>`${allocationIntegrityDefectSql(quotedTable(financialTransaction))}`,
      hasAllocation: sql<boolean>`EXISTS (SELECT 1 FROM "FinancialTransactionAllocation" a WHERE a."transactionId" = "FinancialTransaction"."id" AND a."deletedAt" IS NULL)`,
      requiresBooking: sql<boolean>`${financialTransactionRequiresBookingSql("FinancialTransaction")}`,
      expectation: sql<string>`${financialTransactionItemizationExpectationSql("FinancialTransaction")}`,
      booking: sql<string>`${financialTransactionBookingSql("FinancialTransaction")}`,
      itemization: sql<string>`${financialTransactionCoverageAxisSql("FinancialTransaction", "itemization")}`,
      products: sql<string>`${financialTransactionCoverageAxisSql("FinancialTransaction", "products")}`,
    })
    .from(financialTransaction)
    .where(
      and(
        notDeleted(financialTransaction),
        sql`${financialTransaction.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
}
