import {
  type DataCheck,
  dataCheck,
  dataException,
  type DataQuality,
  type DataQualityException,
  type DataQualityGap,
  dataCheckFacet,
  dataCheckKind,
  dataCheckMessage,
  dataCheckWeight,
  dataCheckScoreCap,
  dataCheckExemptible,
  dataQualityFacets,
  dataChecksByEntity,
  type QualityTerm,
  scoreQualityTerms,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { entityQualityCheckState } from "@cubby/schemas/data-quality-shape";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { z } from "zod";

const qualityPresentationRow = z.object({
  shortcode: z.string(),
  checks: z.partialRecord(dataCheck, entityQualityCheckState),
  exceptions: z.array(dataException),
  score: z.number().nullable().optional(),
});
type QualityPresentationRow = z.output<typeof qualityPresentationRow>;
type Evaluated = Omit<DataQuality, "relatedGaps" | "relatedExceptions">;
type CheckState = QualityTerm["state"];

/**
 * One term per distinct expected check: a gap unless an active exception
 * covers it. A gap or exception on a check that is not expected is ignored,
 * so unrelated (rolled-up) gaps never touch this record's score.
 */
export const qualityTerms = (
  expectedChecks: readonly DataCheck[],
  unresolvedChecks: readonly DataCheck[],
  activeExceptions: readonly DataCheck[],
): Array<QualityTerm & { check: DataCheck }> => {
  const gaps = new Set(unresolvedChecks);
  const exceptions = new Set(activeExceptions);
  return [...new Set(expectedChecks)].map((check) => {
    const state: CheckState = gaps.has(check)
      ? "gap"
      : exceptions.has(check)
        ? "excepted"
        : "satisfied";
    return {
      check,
      weight: dataCheckWeight[check],
      scoreCap: dataCheckScoreCap[check],
      defect: dataCheckKind[check] === "defect",
      state,
    };
  });
};

export const isExpected = (
  row: Pick<QualityPresentationRow, "checks">,
  check: DataCheck,
): boolean =>
  row.checks[check] !== undefined && row.checks[check] !== "not_applicable";

export const evaluateRow = (
  entity: ScoredEntity,
  row: QualityPresentationRow,
): Evaluated => {
  const checks = dataChecksByEntity[entity].options;
  const targetId = parseShortcodeFor(entity, row.shortcode);
  const expectedChecks: DataCheck[] = [];
  const gaps: Array<Omit<DataQualityGap, "check"> & { check: DataCheck }> = [];
  checks.forEach((check) => {
    if (isExpected(row, check)) expectedChecks.push(check);
    if (row.checks[check] !== "gap") return;
    gaps.push({
      check,
      facet: dataCheckFacet[check],
      kind: dataCheckKind[check],
      targetType: entity,
      targetId,
      message: dataCheckMessage[check],
    });
  });
  // Waivers never reopen: every recorded decision on an exemptible check holds.
  const exceptions: DataQualityException[] = row.exceptions.map(
    (exception) => ({
      ...exception,
      targetType: entity,
      targetId,
      state: dataCheckExemptible[exception.check] ? "active" : "stale",
    }),
  );
  // Stored outcomes remain authoritative until publication, including a waiver
  // added or withdrawn since the last pass. Live evaluation carries the same states.
  const activeChecks = new Set(
    checks.filter((check) => row.checks[check] === "waived"),
  );
  const terms = qualityTerms(
    expectedChecks,
    gaps.map((gap) => gap.check),
    [...activeChecks].map((check) => dataCheck.parse(check)),
  );
  const facets = dataQualityFacets[entity].map((name) => ({
    name,
    status: scoreQualityTerms(
      terms.filter((term) => dataCheckFacet[term.check] === name),
    ).status,
    gaps: gaps.filter((gap) => gap.facet === name),
  }));
  const calculated = scoreQualityTerms(terms);
  const score = row.score === undefined ? calculated.score : row.score;
  return { status: calculated.status, score, facets, gaps, exceptions };
};

const publishedQualityValue = z.object({
  score: z.number().nullable(),
  checks: z.record(z.string(), entityQualityCheckState),
});

/** Format this exact publication; do not pair another read's score with its timestamp. */
export function presentPublishedQuality(
  entity: ScoredEntity,
  shortcode: string,
  value: unknown,
  context: DataQuality,
): DataQuality {
  const snapshot = publishedQualityValue.parse(value);
  return {
    ...evaluateRow(entity, {
      shortcode,
      checks: snapshot.checks,
      score: snapshot.score,
      exceptions: context.exceptions.map((exception) =>
        dataException.parse(exception),
      ),
    }),
    relatedGaps: context.relatedGaps,
    relatedExceptions: context.relatedExceptions,
  };
}
