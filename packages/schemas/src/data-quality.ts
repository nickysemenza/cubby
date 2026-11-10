import { z } from "zod";
import { dataExceptionReason } from "./data-quality-shape";
import {
  type DataCheck,
  dataCheck,
  dataCheckKind,
  dataQualityExceptionEntities,
  scoredEntities,
} from "./generated/data-quality-checks.gen";
import { anyShortcodeSchema } from "./identifier-fields";
import { nonEmptyTuple } from "./identifiers";

export {
  dataCheck,
  dataCheckEntity,
  dataCheckFacet,
  dataCheckKind,
  dataCheckLabel,
  dataCheckPresentation,
  dataCheckMessage,
  dataChecksByEntity,
  dataCheckAssessed,
  dataCheckExemptible,
  dataQualityExceptionEntities,
  dataQualityFacets,
  relatedDataQualityEntities,
  scoredEntities,
  type DataCheck,
  type DataCheckOf,
  type ScoredEntity,
} from "./generated/data-quality-checks.gen";
export { qualityStatusOf, type QualityTerm } from "./data-quality-score";
export {
  dataExceptionReason,
  dataExceptionReasonLabel,
  dataQuality,
  dataQualityException,
  dataQualityGap,
  dataQualityStatus,
  type DataExceptionReason,
  type DataQuality,
  type DataQualityException,
  type DataQualityGap,
  type DataQualityStatus,
} from "./data-quality-shape";

type ExceptionEntityMap = typeof dataQualityExceptionEntities;
/** Entities whose declaration enables `DataException` records (ADR 0006). */
export type DataExceptionEntity = {
  [E in keyof ExceptionEntityMap]: ExceptionEntityMap[E] extends true
    ? E
    : never;
}[keyof ExceptionEntityMap];

const dataExceptionEntities = nonEmptyTuple(
  scoredEntities.filter((entity): entity is DataExceptionEntity =>
    Boolean(dataQualityExceptionEntities[entity]),
  ),
);
export const dataExceptionEntity = z.enum(dataExceptionEntities);

/** One `DataException` row as the read path carries it. */
export const dataException = z.object({
  check: dataCheck,
  reason: dataExceptionReason,
  note: z.string().trim().min(1),
});

export const isDefectDataCheck = (check: DataCheck): boolean =>
  dataCheckKind[check] === "defect";

export const setDataExceptionInput = z.object({
  entityId: anyShortcodeSchema(dataExceptionEntities),
  check: dataCheck,
  reason: dataExceptionReason,
  note: z.string().trim().min(1, "Exception note must not be blank"),
});
export type SetDataExceptionInput = z.infer<typeof setDataExceptionInput>;

export const clearDataExceptionInput = z.object({
  entityId: anyShortcodeSchema(dataExceptionEntities),
  check: dataCheck,
});
export type ClearDataExceptionInput = z.infer<typeof clearDataExceptionInput>;
