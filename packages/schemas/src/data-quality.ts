import { z } from "zod";
import { dataExceptionReason } from "./data-quality-shape";
import {
  type DataCheck,
  dataCheck,
  dataCheckKind,
  dataChecksByEntity,
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
export {
  dataQualityCheckKind,
  dataQualityFacetName,
  type DataQualityCheckKind,
  type DataQualityFacetName,
} from "./data-quality-facets";
export {
  dataExceptionReason,
  dataQuality,
  dataQualityException,
  dataQualityFacet,
  dataQualityGap,
  dataQualityGapKind,
  dataQualityStatus,
  type DataExceptionReason,
  type DataQuality,
  type DataQualityException,
  type DataQualityFacet,
  type DataQualityGap,
  type DataQualityGapKind,
  type DataQualityStatus,
} from "./data-quality-shape";

export const purchaseDataCheck = dataChecksByEntity.purchase;
export type PurchaseDataCheck = z.infer<typeof purchaseDataCheck>;
export const productDataCheck = dataChecksByEntity.product;
export type ProductDataCheck = z.infer<typeof productDataCheck>;

/** Only Product and Purchase carry a `dataExceptions` column today; the
 * generic durable-exception store is a tracked follow-up (docs/todos.md). */
export const dataExceptionEntity = z.enum(["purchase", "product"]);

/** A stored `dataExceptions` row: typed against the check registry. */
export const dataException = z.object({
  check: dataCheck,
  reason: dataExceptionReason,
  note: z.string().trim().min(1),
  /** Server-computed evidence signature. Missing only on legacy rows. */
  fingerprint: z.string().min(1).optional(),
});
export type DataException = z.infer<typeof dataException>;

export const isDefectDataCheck = (check: DataCheck): boolean =>
  dataCheckKind[check] === "defect";

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
