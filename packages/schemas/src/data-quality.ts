import { z } from "zod";
import {
  dataQualityCheckKind,
  dataQualityFacetName,
  type DataQualityFacetName,
} from "./data-quality-facets";
import {
  type DataCheck,
  dataCheck,
  dataCheckKind,
  dataChecksByEntity,
  scoredEntities,
} from "./generated/data-quality-checks.gen";
import { anyShortcodeSchema } from "./identifier-fields";

export {
  dataCheck,
  dataCheckEntity,
  dataCheckFacet,
  dataCheckKind,
  dataCheckLabel,
  dataCheckMessage,
  dataChecksByEntity,
  dataCheckWeight,
  dataQualityExceptionEntities,
  dataQualityFacets,
  relatedDataQualityEntities,
  scoredEntities,
  type DataCheck,
  type DataCheckOf,
  type ScoredEntity,
} from "./generated/data-quality-checks.gen";
export { dataQualityFacetName, type DataQualityFacetName };

export const purchaseDataCheck = dataChecksByEntity.purchase;
export type PurchaseDataCheck = z.infer<typeof purchaseDataCheck>;
export const productDataCheck = dataChecksByEntity.product;
export type ProductDataCheck = z.infer<typeof productDataCheck>;

export const dataExceptionReason = z.enum([
  "not_issued",
  "unavailable",
  "history_expired",
  "not_applicable",
  "insufficient_detail",
  "expected_mismatch",
]);
export type DataExceptionReason = z.infer<typeof dataExceptionReason>;

/**
 * Only Product and Purchase carry a `dataExceptions` column today; the
 * generic durable-exception store is a tracked follow-up (docs/todos.md).
 */
export const dataExceptionEntity = z.enum(["purchase", "product"]);

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
  targetType: dataExceptionEntity,
  targetId: z.string(),
  state: z.enum(["active", "stale"]),
});
export type DataQualityException = z.infer<typeof dataQualityException>;

export const dataQualityStatus = z.enum(["complete", "needs_data", "defect"]);
export type DataQualityStatus = z.infer<typeof dataQualityStatus>;

export const dataQualityGapKind = dataQualityCheckKind;
export type DataQualityGapKind = z.infer<typeof dataQualityGapKind>;

export const isDefectDataCheck = (check: DataCheck): boolean =>
  dataCheckKind[check] === "defect";

export const dataQualityGap = z.object({
  check: dataCheck,
  facet: dataQualityFacetName,
  kind: dataQualityGapKind,
  targetType: z.enum(scoredEntities),
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
