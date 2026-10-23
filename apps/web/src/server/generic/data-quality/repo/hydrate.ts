import {
  type DataCheck,
  dataCheck,
  type DataQuality,
  type DataQualityException,
  type DataQualityGap,
  dataCheckFacet,
  dataCheckKind,
  dataCheckLabel,
  dataCheckPresentation,
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
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { exceptionReasonsFor } from "~/server/generic/data-quality/repo/exception-reasons";
import { liveQualityRow } from "~/server/generic/data-quality/repo/registry";

import { storedEntryFor } from "./entries";
import {
  checkMissingCondition,
  checksOf,
  entryFor,
  expectedCondition,
  fingerprintSql,
} from "./sql";
import { evaluateLiveQuality, loadPublishedQuality } from "./stored";

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
      label:
        state === "satisfied"
          ? dataCheckPresentation[check].satisfiedLabel
          : dataCheckLabel[check],
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

/** The lazy explanation uses current inputs, sharing the registered check functions. */
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
          sql`SELECT ${entry.table.id} AS "id" FROM ${entry.table} WHERE ${entry.table.shortcode} = ${id} AND ${liveQualityRow(entry.table)}`,
        )
      ).rows,
    );
  const target = selected[0];
  if (!target)
    throw new Error(`No live ${entity} record for quality explanation`);
  const [row] = await loadEvaluations(db, entity, [target.id], "live");
  if (!row) throw new Error("Quality evaluation was not loaded");
  const evaluation = evaluateRow(entity, row);
  const expected = checksOf(entity).filter(
    (_, index) => row[expectedKey(index)] === true,
  );
  return buildQualityBreakdown(
    expected,
    evaluation.gaps.map((gap) => dataCheck.parse(gap.check)),
    evaluation.exceptions
      .filter(
        (exception) =>
          exception.state === "active" &&
          row[
            gapKey(checksOf(entity).indexOf(dataCheck.parse(exception.check)))
          ] === true,
      )
      .map((exception) => dataCheck.parse(exception.check)),
    evaluation.exceptions,
  );
};

const hydrationRow = z
  .object({
    id: z.string(),
    shortcode: z.string(),
    exceptions: z.array(dataException),
    storedScore: z.number().nullable().optional(),
  })
  .catchall(z.union([z.boolean(), z.string(), z.number(), z.null()]));
const fingerprintColumn = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

const expectedKey = (index: number) => `e${index}`;
const gapKey = (index: number) => `g${index}`;
const fingerprintKey = (index: number) => `f${index}`;
const waivedKey = (index: number) => `w${index}`;

/**
 * One statement per entity: every check's `expected` and raw gap as boolean
 * columns. Rendered through `execute`, not the select builder, because a
 * single-table select builder renders selected columns unqualified and a
 * correlated subquery over the same table then self-joins
 * (docs/agents/domain-rules.md).
 *
 * A fingerprint only decides whether a stored exception still matches its
 * live gap, so it is evaluated afterwards for just those rows and checks.
 * Planning every check's fingerprint for every row roughly doubled the
 * statement for records that carry no exception.
 */
const loadEvaluations = async (
  db: Database | DrizzleTransaction,
  entity: ScoredEntity,
  ids: readonly string[],
  source: "stored" | "live" = "stored",
) => {
  const stored = storedEntryFor(entity);
  if (stored) {
    const rows =
      source === "live"
        ? await evaluateLiveQuality(db, stored, ids)
        : await loadPublishedQuality(db, entity, ids);
    return rows.map((row) =>
      hydrationRow.parse({
        id: row.id,
        shortcode: row.shortcode,
        exceptions: row.exceptions,
        ...("score" in row ? { storedScore: row.score } : {}),
        ...Object.fromEntries(
          checksOf(entity).flatMap((check, index) => {
            const state = row.checks[check] ?? "not_applicable";
            return [
              [expectedKey(index), state !== "not_applicable"],
              [gapKey(index), state === "gap" || state === "waived"],
              [waivedKey(index), state === "waived"],
              [fingerprintKey(index), null],
            ];
          }),
        ),
      }),
    );
  }
  const entry = entryFor(entity);
  const t = entry.table;
  const checks = checksOf(entity);
  const evaluationContext = (selected: readonly string[]) => {
    const derived = entry.derivedRead?.(uuidArrayParam(selected));
    return {
      context: derived ? { derivedAlias: "dq_derived" } : undefined,
      join: derived
        ? sql`LEFT JOIN (${derived}) dq_derived ON dq_derived."entityId" = ${t.id}`
        : sql``,
    };
  };
  const { context, join } = evaluationContext(ids);
  const withExceptions = dataQualityExceptionEntities[entity];
  const columns = checks.flatMap((check, index) => [
    sql`${expectedCondition(entity, check, t, context)} AS ${sql.identifier(expectedKey(index))}`,
    // `missing` alone; `evaluateRow` requires `expected` too. `rawGapCondition`
    // would plan every `expected` twice (see `scoreSql`).
    sql`${checkMissingCondition(entity, check, t, context)} AS ${sql.identifier(gapKey(index))}`,
  ]);
  const exceptions = withExceptions
    ? sql`COALESCE((
  SELECT jsonb_agg(jsonb_build_object(
    'check', dq_exception."check",
    'reason', dq_exception."reason",
    'note', dq_exception."note",
    'fingerprint', dq_exception."fingerprint"
  ) ORDER BY dq_exception."check")
  FROM "DataException" dq_exception
  WHERE dq_exception."entityId" = ${t.id}
    AND dq_exception."check" IN (${sql.join(
      checks.map((check) => sql`${check}`),
      sql`, `,
    )})
), '[]'::jsonb)`
    : sql`'[]'::jsonb`;
  const result = await unwrapDb(db).execute(sql`SELECT
  ${t.id} AS "id",
  ${t.shortcode} AS "shortcode",
  ${exceptions} AS "exceptions",
  ${sql.join(columns, sql`, `)}
FROM ${t}
${join}
WHERE ${t.id} = ANY(${uuidArrayParam(ids)}) AND ${liveQualityRow(t)}`);
  const rows = z.array(hydrationRow).parse(result.rows);
  const compared = checks.flatMap((check, index) => {
    if (!dataCheckExemptible[check]) return [];
    const rowIds = rows
      .filter(
        (row) =>
          row[expectedKey(index)] === true &&
          row[gapKey(index)] === true &&
          row.exceptions.some((exception) => exception.check === check),
      )
      .map((row) => row.id);
    return rowIds.length === 0 ? [] : [{ check, index, rowIds }];
  });
  if (compared.length === 0) return rows;
  const fingerprintIds = uniq(compared.flatMap(({ rowIds }) => rowIds));
  const fingerprinted = evaluationContext(fingerprintIds);
  const fingerprints = await unwrapDb(db).execute(sql`SELECT
  ${t.id} AS "id",
  ${sql.join(
    compared.map(
      ({ check, index, rowIds }) =>
        sql`CASE WHEN ${t.id} = ANY(${uuidArrayParam(rowIds)}) THEN ${fingerprintSql(entity, check, t, fingerprinted.context)} END AS ${sql.identifier(fingerprintKey(index))}`,
    ),
    sql`, `,
  )}
FROM ${t}
${fingerprinted.join}
WHERE ${t.id} = ANY(${uuidArrayParam(fingerprintIds)}) AND ${liveQualityRow(t)}`);
  const byId = new Map(
    z
      .array(hydrationRow.pick({ id: true }).catchall(fingerprintColumn))
      .parse(fingerprints.rows)
      .map((row) => [row.id, row]),
  );
  // Each fingerprint is NULL outside its own compared rows.
  return rows.map((row) => ({ ...row, ...byId.get(row.id) }));
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
  const exceptions: DataQualityException[] =
    !dataQualityExceptionEntities[entity] && !storedEntryFor(entity)
      ? []
      : row.exceptions.map(({ fingerprint, ...exception }) => ({
          ...exception,
          targetType: entity,
          targetId,
          state:
            dataCheckExemptible[exception.check] &&
            (storedEntryFor(entity) ||
              rawByCheck.get(exception.check)?.fingerprint === fingerprint)
              ? "active"
              : "stale",
        }));
  // Stored outcomes remain authoritative until publication, including a waiver
  // added or withdrawn since the last pass. Live evaluation carries the same states.
  const activeChecks = new Set(
    storedEntryFor(entity)
      ? checks.filter((_, index) => row[waivedKey(index)] === true)
      : exceptions
          .filter(
            (exception) =>
              exception.state === "active" &&
              rawByCheck.has(dataCheck.parse(exception.check)),
          )
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
  const calculated = scoreQualityTerms(terms);
  const score =
    row.storedScore === undefined ? calculated.score : row.storedScore;
  return { status: calculated.status, score, facets, gaps, exceptions };
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
WHERE ${t.id} = ANY(${uuidArrayParam(ids)}) AND ${liveQualityRow(t)}
  AND ${liveQualityRow(r)} AND ${link(t, sql`${r.id}`)}`);
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
 * requested id that is deleted or unknown is absent from the map. Record
 * reads evaluate stored-mode checks live; list pages and the Work queue pass
 * `"stored"` so displayed quality matches the published rows they sort by.
 */
export const loadDataQualities = async <E extends ScoredEntity>(
  db: Database | DrizzleTransaction,
  entity: E,
  ids: readonly EntityId<E>[],
  source: "stored" | "live" = "live",
): Promise<Map<EntityId<E>, DataQuality>> => {
  const uniqueIds = uniq(ids);
  const result = new Map<EntityId<E>, DataQuality>();
  if (uniqueIds.length === 0) return result;
  const [rows, relatedIds] = await Promise.all([
    loadEvaluations(db, entity, uniqueIds, source),
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
      for (const row of await loadEvaluations(db, target, targetIds, source))
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
