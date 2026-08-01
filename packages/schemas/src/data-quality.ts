import { z } from "zod";
import { anyShortcodeSchema } from "./identifiers";

export const purchaseDataCheck = z.enum([
  "purchase_date",
  "order_id",
  "stated_total",
  "primary_document",
  "empty_expenses",
  "unpriced_expense",
  "paperwork_mismatch",
  "settlement_reference",
]);
export type PurchaseDataCheck = z.infer<typeof purchaseDataCheck>;

export const productDataCheck = z.enum([
  "product_manufacturer",
  "product_category",
  "product_model",
  "amazon_asin",
  "duplicate_external_id",
]);
export type ProductDataCheck = z.infer<typeof productDataCheck>;

export const dataCheck = z.union([purchaseDataCheck, productDataCheck]);
export type DataCheck = z.infer<typeof dataCheck>;

export const dataExceptionReason = z.enum([
  "not_issued",
  "unavailable",
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

export const dataCheckFacet: Record<DataCheck, DataQualityFacetName> = {
  purchase_date: "identity",
  order_id: "paperwork",
  stated_total: "paperwork",
  primary_document: "paperwork",
  empty_expenses: "ledger",
  unpriced_expense: "ledger",
  paperwork_mismatch: "paperwork",
  settlement_reference: "settlement",
  product_manufacturer: "identity",
  product_category: "identity",
  product_model: "identity",
  amazon_asin: "provenance",
  duplicate_external_id: "integrity",
};

export const defectDataChecks = [
  "paperwork_mismatch",
  "duplicate_external_id",
] as const satisfies readonly DataCheck[];

export const isDefectDataCheck = (
  check: DataCheck,
): check is (typeof defectDataChecks)[number] =>
  defectDataChecks.includes(check as (typeof defectDataChecks)[number]);

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
