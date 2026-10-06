import { z } from "zod";
import {
  dataQualityCheckKind,
  dataQualityFacetName,
} from "./data-quality-facets";

/**
 * The read shape of `dataQuality`, spelled without the generated check
 * registry so an entity declaration (which may not reach `generated/`) can
 * embed another entity's output that carries it. `check` and `targetType`
 * are plain strings here; `@cubby/schemas/data-quality` composes the typed
 * input schemas (filters, exceptions) from the generated enums.
 */
/**
 * `not_assessed`: no applicable check holds a gap and none carries weight, so
 * the score is null. `complete_with_exceptions`: no unresolved gap, but at
 * least one is satisfied only by an accepted exception.
 */
export const dataQualityStatus = z.enum([
  "complete",
  "complete_with_exceptions",
  "needs_data",
  "defect",
  "not_assessed",
]);
export type DataQualityStatus = z.infer<typeof dataQualityStatus>;

export const dataExceptionReason = z.enum([
  "not_issued",
  "unavailable",
  "history_expired",
  "not_applicable",
  "insufficient_detail",
  "expected_mismatch",
]);
export type DataExceptionReason = z.infer<typeof dataExceptionReason>;

/** The one label vocabulary for the "Accept as…" action on every client. */
export const dataExceptionReasonLabel = {
  not_issued: "Never issued",
  unavailable: "Unavailable",
  history_expired: "History expired",
  not_applicable: "Not applicable",
  insufficient_detail: "Insufficient detail",
  expected_mismatch: "Expected mismatch",
} as const satisfies Record<DataExceptionReason, string>;

export const dataQualityGapKind = dataQualityCheckKind;
export type DataQualityGapKind = z.infer<typeof dataQualityGapKind>;

export const dataQualityGap = z.object({
  check: z.string(),
  facet: dataQualityFacetName,
  kind: dataQualityGapKind,
  targetType: z.string(),
  targetId: z.string(),
  message: z.string(),
});
export type DataQualityGap = z.infer<typeof dataQualityGap>;

// Stored exceptions remain target-free because their owning row supplies the
// target. API results make that target explicit for direct and rolled-up data.
export const dataQualityException = z.object({
  check: z.string(),
  reason: dataExceptionReason,
  note: z.string().trim().min(1),
  targetType: z.string(),
  targetId: z.string(),
  state: z.enum(["active", "stale"]),
});
export type DataQualityException = z.infer<typeof dataQualityException>;

export const dataQualityFacet = z.object({
  name: dataQualityFacetName,
  status: dataQualityStatus,
  gaps: z.array(dataQualityGap),
});
export type DataQualityFacet = z.infer<typeof dataQualityFacet>;

export const dataQuality = z.object({
  status: dataQualityStatus,
  /** Null exactly when `status` is `not_assessed`. */
  score: z.number().min(0).max(100).nullable(),
  facets: z.array(dataQualityFacet),
  gaps: z.array(dataQualityGap),
  exceptions: z.array(dataQualityException),
  relatedGaps: z.array(dataQualityGap),
  relatedExceptions: z.array(dataQualityException),
});
export type DataQuality = z.infer<typeof dataQuality>;
