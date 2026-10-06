import { z } from "zod";

import { fieldPolicyValues } from "./field-policy-fields";

export const evidenceExpectationValues = [
  "unknown",
  "required",
  "not_expected",
] as const;
export const evidenceExpectation = z.enum(evidenceExpectationValues);
export type EvidenceExpectation = z.infer<typeof evidenceExpectation>;
/**
 * A SpendingCategory's Product expectation. `not_allowed` is stronger than
 * `not_expected`: an Expense in the category neither expects nor may link a
 * Product (a restaurant meal). `not_expected` only stops the missing-Product
 * gap (groceries still link Products). Coverage stays three-valued. This is
 * the per-row column instance of the field-policy vocabulary, registered as
 * `spendingCategory.productExpectation` in `classification-field-policy.ts`.
 */
export const productExpectationValues = fieldPolicyValues;
export const productExpectation = z.enum(productExpectationValues);
export type ProductExpectation = z.infer<typeof productExpectation>;

export const purchaseEvidenceCoverage = z.object({
  expectation: evidenceExpectation,
  booking: z.enum(["missing", "partial", "recorded"]),
  document: z.enum(["missing", "present", "not_expected", "unknown"]),
  itemization: z.enum(["missing", "present", "not_expected", "unknown"]),
  products: z.enum([
    "missing",
    "partial",
    "present",
    "not_expected",
    "unknown",
  ]),
});
export type PurchaseEvidenceCoverage = z.infer<typeof purchaseEvidenceCoverage>;

export const financialTransactionCoverage = z.object({
  expectation: evidenceExpectation,
  booking: z.enum([
    "missing",
    "partial",
    "recorded",
    "not_applicable",
    "unclassified",
  ]),
  document: z.enum([
    "missing",
    "partial",
    "present",
    "not_expected",
    "unknown",
  ]),
  itemization: z.enum([
    "missing",
    "partial",
    "present",
    "not_expected",
    "unknown",
  ]),
  products: z.enum([
    "missing",
    "partial",
    "present",
    "not_expected",
    "unknown",
  ]),
});
export type FinancialTransactionCoverage = z.infer<
  typeof financialTransactionCoverage
>;
