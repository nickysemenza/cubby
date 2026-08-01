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
export const dataException = z.object(dataExceptionFields);
export type DataException = z.infer<typeof dataException>;

// Stored exceptions remain target-free because their owning row supplies the
// target. API results make that target explicit for direct and rolled-up data.
export const dataQualityException = z.object({
  ...dataExceptionFields,
  targetType: z.enum(["purchase", "product"]),
  targetId: z.string(),
});
export type DataQualityException = z.infer<typeof dataQualityException>;

export const dataQualityStatus = z.enum(["complete", "needs_data"]);
export type DataQualityStatus = z.infer<typeof dataQualityStatus>;

export const dataQualityGap = z.object({
  check: dataCheck,
  targetType: z.enum(["purchase", "product"]),
  targetId: z.string(),
  message: z.string(),
});
export type DataQualityGap = z.infer<typeof dataQualityGap>;

export const dataQuality = z.object({
  status: dataQualityStatus,
  gaps: z.array(dataQualityGap),
  exceptions: z.array(dataQualityException),
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
