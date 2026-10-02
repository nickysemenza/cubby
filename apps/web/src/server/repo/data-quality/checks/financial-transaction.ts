import { getTableName, sql } from "drizzle-orm";

import { financialTransaction } from "~/server/db/schema";
import { allocationIntegrityDefectSql } from "~/server/repo/financial-allocation-integrity";
import {
  financialTransactionBookingSql,
  financialTransactionCoverageAxisSql,
  financialTransactionEvidenceFingerprintSql,
  financialTransactionEvidenceExpectationSql,
  financialTransactionRequiresBookingSql,
} from "~/server/repo/purchase-evidence-policy";

import { defineEntityChecks } from "../registry";

type FinancialTransaction = typeof financialTransaction;

const requiresEvidence = (t: FinancialTransaction) =>
  sql`(${financialTransactionRequiresBookingSql(getTableName(t))} AND ${financialTransactionEvidenceExpectationSql(getTableName(t))} = 'required')`;
const axis = (
  t: FinancialTransaction,
  name: "document" | "itemization" | "products",
) => financialTransactionCoverageAxisSql(getTableName(t), name);
const evidenceFingerprint = (t: FinancialTransaction) => [
  financialTransactionRequiresBookingSql(getTableName(t)),
  financialTransactionEvidenceExpectationSql(getTableName(t)),
  financialTransactionEvidenceFingerprintSql(getTableName(t)),
];

const hasLiveAllocation = (t: FinancialTransaction) => sql`EXISTS (
  SELECT 1 FROM "FinancialTransactionAllocation" dq_fta
  WHERE dq_fta."transactionId" = ${t.id} AND dq_fta."deletedAt" IS NULL
)`;

export const financialTransactionChecks = defineEntityChecks({
  entity: "financialTransaction",
  table: financialTransaction,
  checks: {
    financial_transaction_allocation_integrity: {
      missing: (t) => allocationIntegrityDefectSql(`"${getTableName(t)}"`),
    },
    financial_transaction_classification: {
      expected: (t) => sql`${t.status} <> 'void'`,
      missing: (t) => sql`${t.kind} = 'other'`,
      fingerprint: (t) => [sql`${t.kind}`, sql`${t.status}`],
    },
    financial_transaction_allocation: {
      expected: (t) => financialTransactionRequiresBookingSql(getTableName(t)),
      missing: (t) => sql`NOT ${hasLiveAllocation(t)}`,
      fingerprint: (t) => [
        financialTransactionRequiresBookingSql(getTableName(t)),
        hasLiveAllocation(t),
      ],
    },
    financial_transaction_merchant: {
      expected: (t) => financialTransactionRequiresBookingSql(getTableName(t)),
      missing: (t) => sql`(${t.merchant} IS NULL OR trim(${t.merchant}) = '')`,
      fingerprint: (t) => [sql`${t.merchant}`],
    },
    financial_transaction_evidence_expectation: {
      expected: (t) => financialTransactionRequiresBookingSql(getTableName(t)),
      missing: (t) =>
        sql`${financialTransactionEvidenceExpectationSql(getTableName(t))} = 'unknown'`,
      fingerprint: (t) => [
        financialTransactionEvidenceExpectationSql(getTableName(t)),
      ],
    },
    financial_transaction_booking: {
      expected: (t) => financialTransactionRequiresBookingSql(getTableName(t)),
      missing: (t) =>
        sql`${financialTransactionBookingSql(getTableName(t))} IN ('missing', 'partial')`,
      fingerprint: (t) => [financialTransactionBookingSql(getTableName(t))],
    },
    financial_transaction_document: {
      expected: requiresEvidence,
      missing: (t) => sql`${axis(t, "document")} IN ('missing', 'partial')`,
      fingerprint: (t) => [...evidenceFingerprint(t), axis(t, "document")],
    },
    financial_transaction_itemization: {
      expected: requiresEvidence,
      missing: (t) => sql`${axis(t, "itemization")} IN ('missing', 'partial')`,
      fingerprint: (t) => [...evidenceFingerprint(t), axis(t, "itemization")],
    },
    financial_transaction_products: {
      expected: (t) =>
        sql`(${financialTransactionRequiresBookingSql(getTableName(t))} AND ${axis(t, "products")} IN ('missing', 'partial', 'present'))`,
      missing: (t) => sql`${axis(t, "products")} IN ('missing', 'partial')`,
      fingerprint: (t) => [...evidenceFingerprint(t), axis(t, "products")],
    },
  },
});
