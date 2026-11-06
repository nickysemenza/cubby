import { sql } from "drizzle-orm";

import { outer, quotedTable, related } from "~/server/db/helpers/related";
import {
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import { allocationIntegrityDefectSql } from "~/server/domains/financial-transaction/repo/financial-allocation-integrity";
import {
  financialTransactionBookingSql,
  financialTransactionCoverageAxisSql,
  financialTransactionItemizationExpectationSql,
  financialTransactionRequiresBookingSql,
} from "~/server/domains/purchase/repo/purchase-evidence-policy";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const loadFinancialTransactionQualityRecords = qualityCheck.records(
  "financialTransaction",
  financialTransaction,
  {
    status: financialTransaction.status,
    kind: financialTransaction.kind,
    merchant: financialTransaction.merchant,
    allocationDefect: sql<boolean>`${allocationIntegrityDefectSql(quotedTable(financialTransaction))}`,
    hasAllocation: related(
      financialTransactionAllocation,
      (a) => sql`${a.transactionId} = ${outer(financialTransaction.id)}`,
    ).exists(),
    requiresBooking: sql<boolean>`${financialTransactionRequiresBookingSql("FinancialTransaction")}`,
    expectation: sql<string>`${financialTransactionItemizationExpectationSql("FinancialTransaction")}`,
    booking: sql<string>`${financialTransactionBookingSql("FinancialTransaction")}`,
    itemization: sql<string>`${financialTransactionCoverageAxisSql("FinancialTransaction", "itemization")}`,
    products: sql<string>`${financialTransactionCoverageAxisSql("FinancialTransaction", "products")}`,
  },
);

/** Bump when the rules or their declared scoring metadata change. */
const FINANCIAL_TRANSACTION_QUALITY_RULES_VERSION = 3;
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
