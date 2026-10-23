import type { EntityQualityCheckState } from "@cubby/schemas/data-quality-shape";

type CheckState = Exclude<EntityQualityCheckState, "waived">;
export type QualityCheck<Record> = (record: Record) => CheckState;

/** Shared predicates consume a batch-loaded record and never perform I/O. */
const observed =
  <R>(predicate: (record: R) => boolean): QualityCheck<R> =>
  (record) =>
    predicate(record) ? "pass" : "gap";

const required = <R>(field: keyof R): QualityCheck<R> =>
  observed((record) => {
    const value = record[field];
    return (
      value !== null &&
      value !== undefined &&
      (typeof value !== "string" || value.trim().length > 0)
    );
  });

const hasRelated = <R>(
  read: (record: R) => readonly unknown[],
): QualityCheck<R> => observed((record) => read(record).length > 0);

const hasImage = observed<{ hasDisplayImage: boolean }>(
  (record) => record.hasDisplayImage,
);

const when =
  <R>(
    applies: (record: R) => boolean,
    check: QualityCheck<R>,
  ): QualityCheck<R> =>
  (record) =>
    applies(record) ? check(record) : "not_applicable";

/** Shared check construction API for entity ports. */
export const qualityCheck = { required, hasRelated, hasImage, observed, when };
