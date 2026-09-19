import { z } from "zod";
import { anyShortcodeSchema } from "./identifier-fields";

export const purchaseDataCheck = z.enum([
  "purchase_date",
  "order_id",
  "stated_total",
  "primary_document",
  "empty_expenses",
  "unpriced_expense",
  "paperwork_mismatch",
  "settlement_reference",
  "settlement_mismatch",
]);
export type PurchaseDataCheck = z.infer<typeof purchaseDataCheck>;

export const productDataCheck = z.enum([
  "product_manufacturer",
  "product_category",
  "product_model",
  "product_image",
  "amazon_asin",
  "duplicate_external_id",
]);
export type ProductDataCheck = z.infer<typeof productDataCheck>;

export const dataCheck = z.union([purchaseDataCheck, productDataCheck]);
export type DataCheck = z.infer<typeof dataCheck>;

export const dataExceptionReason = z.enum([
  "not_issued",
  "unavailable",
  "history_expired",
  "not_applicable",
  "insufficient_detail",
  "expected_mismatch",
]);
export type DataExceptionReason = z.infer<typeof dataExceptionReason>;

const dataExceptionFields = {
  check: dataCheck,
  reason: dataExceptionReason,
  note: z.string().trim().min(1),
};
export const dataException = z.object({
  ...dataExceptionFields,
  /** Server-computed evidence signature. Missing only on legacy rows. */
  fingerprint: z.string().min(1).optional(),
});
export type DataException = z.infer<typeof dataException>;

// Stored exceptions remain target-free because their owning row supplies the
// target. API results make that target explicit for direct and rolled-up data.
export const dataQualityException = z.object({
  ...dataExceptionFields,
  targetType: z.enum(["purchase", "product"]),
  targetId: z.string(),
  state: z.enum(["active", "stale"]),
});
export type DataQualityException = z.infer<typeof dataQualityException>;

export const dataQualityStatus = z.enum(["complete", "needs_data", "defect"]);
export type DataQualityStatus = z.infer<typeof dataQualityStatus>;

export const dataQualityFacetName = z.enum([
  "identity",
  "paperwork",
  "ledger",
  "settlement",
  "provenance",
  "integrity",
]);
export type DataQualityFacetName = z.infer<typeof dataQualityFacetName>;

export const dataQualityGapKind = z.enum(["missing", "defect"]);
export type DataQualityGapKind = z.infer<typeof dataQualityGapKind>;

export const dataCheckFacet = {
  purchase_date: "identity",
  order_id: "paperwork",
  stated_total: "paperwork",
  primary_document: "paperwork",
  empty_expenses: "ledger",
  unpriced_expense: "ledger",
  paperwork_mismatch: "paperwork",
  settlement_reference: "settlement",
  settlement_mismatch: "settlement",
  product_manufacturer: "identity",
  product_category: "identity",
  product_model: "identity",
  // `provenance`, not `identity`: a product carrying UPC + model + ASIN is
  // fully identified without a photograph. The image is evidence of the thing,
  // which is what this facet already collects for `amazon_asin`.
  product_image: "provenance",
  amazon_asin: "provenance",
  duplicate_external_id: "integrity",
} satisfies Record<DataCheck, DataQualityFacetName>;

export const defectDataChecks = [
  "paperwork_mismatch",
  "settlement_mismatch",
  "duplicate_external_id",
] as const satisfies readonly DataCheck[];

/**
 * Central weights make quality score arithmetic explicit and extensible. A
 * score divides satisfied expected weight by expected weight; every currently
 * defined check has equal weight until product policy deliberately changes it.
 */
export const dataCheckWeight = {
  purchase_date: 1,
  order_id: 1,
  stated_total: 1,
  primary_document: 1,
  empty_expenses: 1,
  unpriced_expense: 1,
  paperwork_mismatch: 1,
  settlement_reference: 1,
  settlement_mismatch: 1,
  product_manufacturer: 1,
  product_category: 1,
  product_model: 1,
  product_image: 1,
  amazon_asin: 1,
  duplicate_external_id: 1,
} as const satisfies Record<DataCheck, number>;

export const isDefectDataCheck = (
  check: DataCheck,
): check is (typeof defectDataChecks)[number] =>
  new Set<DataCheck>(defectDataChecks).has(check);

export const dataQualityGap = z.object({
  check: dataCheck,
  facet: dataQualityFacetName,
  kind: dataQualityGapKind,
  targetType: z.enum(["purchase", "product"]),
  targetId: z.string(),
  message: z.string(),
});
export type DataQualityGap = z.infer<typeof dataQualityGap>;

export const dataQualityFacet = z.object({
  name: dataQualityFacetName,
  status: dataQualityStatus,
  gaps: z.array(dataQualityGap),
});
export type DataQualityFacet = z.infer<typeof dataQualityFacet>;

export const dataQuality = z.object({
  status: dataQualityStatus,
  score: z.number().min(0).max(100).default(100),
  facets: z.array(dataQualityFacet),
  gaps: z.array(dataQualityGap),
  exceptions: z.array(dataQualityException),
  relatedGaps: z.array(dataQualityGap),
  relatedExceptions: z.array(dataQualityException),
});
export type DataQuality = z.infer<typeof dataQuality>;

export const setDataExceptionInput = z.object({
  entityId: anyShortcodeSchema(["purchase", "product"]),
  check: dataCheck,
  reason: dataExceptionReason,
  note: z.string().trim().min(1, "Exception note must not be blank"),
});
export type SetDataExceptionInput = z.infer<typeof setDataExceptionInput>;

export const clearDataExceptionInput = z.object({
  entityId: anyShortcodeSchema(["purchase", "product"]),
  check: dataCheck,
});
export type ClearDataExceptionInput = z.infer<typeof clearDataExceptionInput>;
