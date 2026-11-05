import type { AssessmentReadCoverage } from "@cubby/schemas/assessment-read-publication";

/** Coverage describes known published results, not execution progress. */
export function publicationCoverageMessage(
  coverage: AssessmentReadCoverage | undefined,
) {
  return coverage?.failed
    ? "Suggestion refresh failed. Showing known results."
    : coverage?.missing
      ? "Some suggestions have not been assessed yet."
      : coverage?.stale || coverage?.unresolved
        ? "Suggestions may be out of date."
        : null;
}
