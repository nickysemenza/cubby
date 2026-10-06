import {
  type DataCheck,
  dataCheck,
  type DataQuality,
  type DataQualityException,
  type DataQualityGap,
  dataCheckFacet,
  dataCheckKind,
  dataCheckLabel,
  dataCheckMessage,
  dataCheckWeight,
  dataCheckScoreCap,
  dataCheckExemptible,
  DEFAULT_UNRESOLVED_SCORE_CAP,
  dataException,
  dataExceptionReasonLabel,
  dataQualityExceptionEntities,
  dataQualityFacets,
  relatedDataQualityEntities,
  type QualityScore,
  type QualityTerm,
  scoreQualityTerms,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { qualityBreakdown } from "@cubby/schemas/field-explanation";
import { type EntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { uniq, uniqBy } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/repo/database-helpers";

import { exceptionReasonsFor } from "./exception-reasons";
import {
  checkMissingCondition,
  checksOf,
  entryFor,
  expectedCondition,
  fingerprintSql,
} from "./sql";

type CheckState = QualityTerm["state"];

const effectiveScoreCap = (check: DataCheck): number =>
  dataCheckScoreCap[check] ?? DEFAULT_UNRESOLVED_SCORE_CAP;

/**
 * One term per distinct expected check: a gap unless an active exception
 * covers it. A gap or exception on a check that is not expected is ignored,
 * so unrelated (rolled-up) gaps never touch this record's score.
 */
const qualityTerms = (
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

/**
 * A target's score is independent of related entities: a Purchase can be
 * complete on its own evidence while a linked Product remains incomplete.
 * Active exceptions are absent from `unresolvedGaps`, and therefore count as
 * satisfied. No applicable check is null (not assessed), never a perfect score.
 */
export const calculateDataQualityScore = (
  expectedChecks: readonly DataCheck[],
  unresolvedGaps: readonly { check: DataCheck }[],
): number | null =>
  scoreQualityTerms(
    qualityTerms(
      expectedChecks,
      unresolvedGaps.map((gap) => gap.check),
      [],
    ),
  ).score;

const exceptionOf = (
  recorded: readonly DataQualityException[],
  check: string,
) => {
  const found = recorded.find((exception) => exception.check === check);
  return found
    ? {
        exception: {
          reason: found.reason,
          note: found.note,
          state: found.state,
        },
      }
    : {};
};

const quoted = (checks: readonly DataCheck[]) =>
  checks.map((check) => `“${dataCheckLabel[check]}”`).join(", ");

/** The score arithmetic, naming the unresolved checks that cap it. */
const scoreSummary = (
  result: QualityScore,
  terms: ReadonlyArray<QualityTerm & { check: DataCheck }>,
): string => {
  const capping = terms
    .filter(
      (term) =>
        term.state === "gap" &&
        effectiveScoreCap(term.check) === result.scoreCap,
    )
    .map((term) => term.check);
  const verb = capping.length === 1 ? "is" : "are";
  const accepted =
    result.status === "complete_with_exceptions"
      ? " All checks pass; accepted exceptions count as satisfied."
      : "";
  if (result.score === null)
    return terms.length === 0
      ? "No applicable checks: quality is not assessed."
      : "No applicable weighted checks: quality is not assessed. Unscored diagnostics remain visible below.";
  if (result.weightedScore === null)
    return `No applicable weighted checks; unresolved ${quoted(capping)} caps the score at ${result.scoreCap} → ${result.score}/100`;
  const arithmetic = `${result.satisfiedWeight} satisfied weight ÷ ${result.expectedWeight} applicable weight × 100 = ${result.weightedScore}`;
  return result.scoreCap !== null && result.scoreCap < result.weightedScore
    ? `${arithmetic}, capped at ${result.scoreCap} while ${quoted(capping)} ${verb} unresolved → ${result.score}/100`
    : `${arithmetic}/100${accepted}`;
};

export const buildQualityBreakdown = (
  expectedChecks: readonly DataCheck[],
  unresolvedChecks: readonly DataCheck[],
  activeExceptions: readonly DataCheck[],
  recorded: readonly DataQualityException[] = [],
): z.infer<typeof qualityBreakdown> => {
  const terms = qualityTerms(
    expectedChecks,
    unresolvedChecks,
    activeExceptions,
  );
  const result = scoreQualityTerms(terms);
  return qualityBreakdown.parse({
    score: result.score,
    status: result.status,
    weightedScore: result.weightedScore,
    scoreCap: result.scoreCap,
    expectedWeight: result.expectedWeight,
    satisfiedWeight: result.satisfiedWeight,
    summary: scoreSummary(result, terms),
    checks: terms.map(({ check, state }) => ({
      check,
      label: dataCheckLabel[check],
      facet: dataCheckFacet[check],
      kind: dataCheckKind[check],
      weight: dataCheckWeight[check],
      scoreCap: effectiveScoreCap(check),
      state,
      stateLabel:
        state === "gap"
          ? dataCheckKind[check] === "defect"
            ? "Defect"
            : "Missing data"
          : state === "excepted"
            ? "Accepted exception"
            : "Satisfied",
      weightLabel: [
        dataCheckWeight[check] === 0
          ? "Unscored diagnostic"
          : `weight ${dataCheckWeight[check]}`,
        dataCheckScoreCap[check] === null
          ? null
          : `caps at ${dataCheckScoreCap[check]} while unresolved`,
      ]
        .filter(Boolean)
        .join(" · "),
      description: dataCheckMessage[check],
      exceptionReasons: exceptionReasonsFor(check).map((reason) => ({
        reason,
        label: dataExceptionReasonLabel[reason],
      })),
      ...exceptionOf(recorded, check),
    })),
  });
};

/** The lazy explanation reuses the same SQL evaluation as list hydration. */
export const loadQualityBreakdown = async (
  db: Database | DrizzleTransaction,
  entity: ScoredEntity,
  id: string,
) => {
  const entry = entryFor(entity);
  const selected = z
    .array(z.object({ id: z.string() }))
    .parse(
      (
        await unwrapDb(db).execute(
          sql`SELECT ${entry.table.id} AS "id" FROM ${entry.table} WHERE ${entry.table.shortcode} = ${id} AND ${entry.table.deletedAt} IS NULL`,
        )
      ).rows,
    );
  const target = selected[0];
  if (!target)
    throw new Error(`No live ${entity} record for quality explanation`);
  const [row] = await loadEvaluations(db, entity, [target.id]);
  if (!row) throw new Error("Quality evaluation was not loaded");
  const evaluation = evaluateRow(entity, row);
  const expected = checksOf(entity).filter(
    (_, index) => row[expectedKey(index)] === true,
  );
  return buildQualityBreakdown(
    expected,
    evaluation.gaps.map((gap) => dataCheck.parse(gap.check)),
    evaluation.exceptions
      .filter((exception) => exception.state === "active")
      .map((exception) => dataCheck.parse(exception.check)),
    evaluation.exceptions,
  );
};

const hydrationRow = z
  .object({
    id: z.string(),
    shortcode: z.string(),
    exceptions: z.array(dataException),
  })
  .catchall(z.union([z.boolean(), z.string(), z.null()]));
const fingerprintColumn = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

const expectedKey = (index: number) => `e${index}`;
const gapKey = (index: number) => `g${index}`;
const fingerprintKey = (index: number) => `f${index}`;

/**
 * One statement per entity: every check's `expected`, raw gap and (where the
 * entity has exceptions) fingerprint as boolean/text columns. Rendered through
 * `execute`, not the select builder, because a single-table select builder
 * renders selected columns unqualified and a correlated subquery over the
 * same table then self-joins (docs/agents/domain-rules.md).
 */
const loadEvaluations = async (
  db: Database | DrizzleTransaction,
  entity: ScoredEntity,
  ids: readonly string[],
) => {
  const entry = entryFor(entity);
  const t = entry.table;
  const checks = checksOf(entity);
  const withFingerprints = dataQualityExceptionEntities[entity];
  const columns = checks.flatMap((check, index) => [
    sql`${expectedCondition(entity, check, t)} AS ${sql.identifier(expectedKey(index))}`,
    // `missing` alone; `evaluateRow` requires `expected` too. `rawGapCondition`
    // would plan every `expected` twice (see `scoreSql`).
    sql`${checkMissingCondition(entity, check, t)} AS ${sql.identifier(gapKey(index))}`,
    ...(withFingerprints
      ? [
          sql`${fingerprintSql(entity, check, t)} AS ${sql.identifier(fingerprintKey(index))}`,
        ]
      : []),
  ]);
  const exceptions = withFingerprints
    ? sql`COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'check', dq_exception."check",
    'reason', dq_exception."reason",
    'note', dq_exception."note",
    'fingerprint', dq_exception."fingerprint"
  ) ORDER BY dq_exception."check")
  FROM "DataException" dq_exception
  WHERE dq_exception."entityId" = ${t.id}
), '[]'::jsonb)`
    : sql`'[]'::jsonb`;
  const result = await unwrapDb(db).execute(sql`SELECT
  ${t.id} AS "id",
  ${t.shortcode} AS "shortcode",
  ${exceptions} AS "exceptions",
  ${sql.join(columns, sql`, `)}
FROM ${t}
WHERE ${t.id} = ANY(${uuidArrayParam(ids)}) AND ${t.deletedAt} IS NULL`);
  return z.array(hydrationRow).parse(result.rows);
};

type Evaluated = Omit<DataQuality, "relatedGaps" | "relatedExceptions">;

const targetKey = (target: { targetType: string; targetId: string }) =>
  `${target.targetType}:${target.targetId}`;

const evaluateRow = (
  entity: ScoredEntity,
  row: z.infer<typeof hydrationRow>,
): Evaluated => {
  const checks = checksOf(entity);
  const targetId = parseShortcodeFor(entity, row.shortcode);
  const expectedChecks: DataCheck[] = [];
  const rawGaps: Array<
    Omit<DataQualityGap, "check"> & {
      check: DataCheck;
      fingerprint: string | null;
    }
  > = [];
  checks.forEach((check, index) => {
    if (row[expectedKey(index)] === true) expectedChecks.push(check);
    if (row[expectedKey(index)] !== true || row[gapKey(index)] !== true) return;
    rawGaps.push({
      check,
      facet: dataCheckFacet[check],
      kind: dataCheckKind[check],
      targetType: entity,
      targetId,
      message: dataCheckMessage[check],
      fingerprint: fingerprintColumn.parse(row[fingerprintKey(index)]),
    });
  });
  const rawByCheck = new Map(rawGaps.map((gap) => [gap.check, gap]));
  const exceptions: DataQualityException[] = !dataQualityExceptionEntities[
    entity
  ]
    ? []
    : row.exceptions.map(({ fingerprint, ...exception }) => ({
        ...exception,
        targetType: entity,
        targetId,
        state:
          dataCheckExemptible[exception.check] &&
          rawByCheck.get(exception.check)?.fingerprint === fingerprint
            ? "active"
            : "stale",
      }));
  const activeChecks = new Set(
    exceptions
      .filter((exception) => exception.state === "active")
      .map((exception) => exception.check),
  );
  const gaps = rawGaps
    .filter((gap) => !activeChecks.has(gap.check))
    .map(({ fingerprint: _fingerprint, ...gap }) => gap);
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
  const { score, status } = scoreQualityTerms(terms);
  return { status, score, facets, gaps, exceptions };
};

/** `(ownerId, relatedId)` pairs for every declared roll-up relation. */
const loadRelatedIds = async (
  db: Database | DrizzleTransaction,
  entity: ScoredEntity,
  ids: readonly string[],
): Promise<Map<string, Array<{ entity: ScoredEntity; id: string }>>> => {
  const entry = entryFor(entity);
  const related = new Map<
    string,
    Array<{ entity: ScoredEntity; id: string }>
  >();
  for (const target of relatedDataQualityEntities[entity]) {
    const link = entry.related?.[target];
    if (!link) throw new Error(`${entity} declares no link to ${target}.`);
    const t = entry.table;
    const r = entryFor(target).table;
    const result = await unwrapDb(db).execute(sql`SELECT
  ${t.id} AS "ownerId", ${r.id} AS "relatedId"
FROM ${t}, ${r}
WHERE ${t.id} = ANY(${uuidArrayParam(ids)}) AND ${t.deletedAt} IS NULL
  AND ${r.deletedAt} IS NULL AND ${link(t, sql`${r.id}`)}`);
    for (const row of z
      .array(z.object({ ownerId: z.string(), relatedId: z.string() }))
      .parse(result.rows)) {
      const list = related.get(row.ownerId) ?? [];
      list.push({ entity: target, id: row.relatedId });
      related.set(row.ownerId, list);
    }
  }
  return related;
};

/**
 * Real, computed `DataQuality` for live rows of one entity, keyed by id. A
 * requested id that is deleted or unknown is absent from the map.
 */
export const loadDataQualities = async <E extends ScoredEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  ids: readonly EntityId<E>[],
): Promise<Map<EntityId<E>, DataQuality>> => {
  const uniqueIds = uniq(ids);
  const result = new Map<EntityId<E>, DataQuality>();
  if (uniqueIds.length === 0) return result;
  const [rows, relatedIds] = await Promise.all([
    loadEvaluations(db, entity, uniqueIds),
    loadRelatedIds(db, entity, uniqueIds),
  ]);
  // Roll-ups are one hop (the generator rejects chains): a related row
  // contributes its own gaps and exceptions, never its own roll-ups.
  const relatedQualities = new Map<ScoredEntity, Map<string, Evaluated>>();
  for (const target of relatedDataQualityEntities[entity]) {
    const targetIds = uniq(
      [...relatedIds.values()].flatMap((links) =>
        links.filter((link) => link.entity === target).map((link) => link.id),
      ),
    );
    const evaluated = new Map<string, Evaluated>();
    if (targetIds.length > 0)
      for (const row of await loadEvaluations(db, target, targetIds))
        evaluated.set(row.id, evaluateRow(target, row));
    relatedQualities.set(target, evaluated);
  }
  for (const row of rows) {
    const relatedGaps: DataQualityGap[] = [];
    const relatedExceptions: DataQualityException[] = [];
    for (const link of relatedIds.get(row.id) ?? []) {
      const quality = relatedQualities.get(link.entity)?.get(link.id);
      relatedGaps.push(...(quality?.gaps ?? []));
      relatedExceptions.push(...(quality?.exceptions ?? []));
    }
    // SAFETY: the row was selected by `id = ANY(ids)` from the entity's table.
    result.set(row.id as EntityId<E>, {
      ...evaluateRow(entity, row),
      relatedGaps: uniqBy(
        relatedGaps,
        (gap) => `${targetKey(gap)}:${gap.check}`,
      ),
      relatedExceptions: uniqBy(
        relatedExceptions,
        (exception) => `${targetKey(exception)}:${exception.check}`,
      ),
    });
  }
  return result;
};

/**
 * Attach each row's real, computed DataQuality — never a hardcoded-complete
 * placeholder. Rows here were just fetched live, so a missing evaluation is
 * a bug, not a soft-deleted row.
 */
export const attachDataQuality = async <
  E extends ScoredEntity,
  T extends { id: EntityId<E> },
>(
  db: Database | DrizzleTransaction,
  entity: E,
  rows: readonly T[],
): Promise<Array<T & { dataQuality: DataQuality }>> => {
  const qualities = await loadDataQualities(
    db,
    entity,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const dataQuality = qualities.get(row.id);
    if (!dataQuality) {
      throw new Error(`Data quality was not loaded for ${entity} ${row.id}`);
    }
    return { ...row, dataQuality };
  });
};
