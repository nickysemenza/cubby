import { z } from "zod";

export const evidenceExpectationValues = [
  "unknown",
  "required",
  "not_expected",
] as const;
export const evidenceExpectation = z.enum(evidenceExpectationValues);
export type EvidenceExpectation = z.infer<typeof evidenceExpectation>;

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
