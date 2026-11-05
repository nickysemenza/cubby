import type { DataQualityStatus } from "./data-quality-shape";

/** One applicable-or-not check of one record, as TS and SQL both read it. */
export type QualityTerm = {
  /** False for a diagnostic, which alone never makes a record assessed. */
  assessed: boolean;
  defect: boolean;
  state: "not_applicable" | "satisfied" | "gap" | "excepted";
};

/**
 * The one status rule; `statusFromStates` in the web repo's `data-quality/sql.ts`
 * spells it in SQL. A defect outranks a gap. With nothing unresolved, a record
 * with no assessed check applying is not assessed, which is not complete.
 */
export const qualityStatusOf = (
  terms: readonly QualityTerm[],
): DataQualityStatus => {
  const applicable = terms.filter((term) => term.state !== "not_applicable");
  const gaps = applicable.filter((term) => term.state === "gap");
  if (gaps.some((term) => term.defect)) return "defect";
  if (gaps.length > 0) return "needs_data";
  if (!applicable.some((term) => term.assessed)) return "not_assessed";
  return applicable.some((term) => term.state === "excepted")
    ? "complete_with_exceptions"
    : "complete";
};
