import {
  DEFAULT_UNRESOLVED_SCORE_CAP,
  dataCheckExemptible,
  dataCheckScoreCap,
  type DataCheck,
  type DataQualityStatus,
  dataCheckEntity,
  dataChecksByEntity,
  dataCheckWeight,
  dataQualityExceptionEntities,
  dataQualityStatus,
  isDefectDataCheck,
  type QualityTerm,
  relatedDataQualityEntities,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { getTableName, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { type DataQualityEntries, dataQualityEntries } from "./entries";
import {
  liveQualityRow,
  type CheckBinding,
  type EntityChecks,
  type ScoredTable,
} from "./registry";

/**
 * Every builder here returns ONE parenthesized group. Callers embed these
 * under `NOT` and beside `OR`, and
 * `NOT a AND b` once emptied a production worklist because the group was a
 * bare conjunction. The unit test asserts the shape on the rendered SQL.
 */
const group = (inner: SQL): SQL => sql`(${inner})`;

const entries: DataQualityEntries = dataQualityEntries;

/** One registry entry, read through the erased-table contract. */
export const entryFor = (
  entity: ScoredEntity,
): EntityChecks<ScoredEntity, ScoredTable> => entries[entity];

const bindingFor = (
  entity: ScoredEntity,
  check: DataCheck,
): CheckBinding<ScoredTable> => {
  const binding = Object.entries(entryFor(entity).checks).find(
    ([id]) => id === check,
  )?.[1];
  if (!binding)
    throw new Error(`${check} is not a ${entity} data-quality check.`);
  return binding;
};

export const checksOf = (entity: ScoredEntity): readonly DataCheck[] =>
  dataChecksByEntity[entity].options;

const hasExceptions = (entity: ScoredEntity): boolean =>
  dataQualityExceptionEntities[entity];

const fingerprintValue = (value: SQL): SQL =>
  sql`COALESCE(to_jsonb(${value})::text, 'null')`;

/**
 * `<check>:<input>|<input>…` with JSON scalar spelling, so null, strings,
 * numbers and booleans are unambiguous and an exception never couples to an
 * unrelated row timestamp. `hydrate.ts` compares stored fingerprints against
 * exactly this rendering.
 */
export const fingerprintSql = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable = entryFor(entity).table,
): SQL => {
  const binding = bindingFor(entity, check);
  if (!dataCheckExemptible[check]) return sql`NULL::text`;
  if (!binding.fingerprint)
    throw new Error(`${check} declares no fingerprint inputs.`);
  return sql`${check} || ':' || concat_ws('|', ${sql.join(
    [...binding.fingerprint(t)].map(fingerprintValue),
    sql`, `,
  )})`;
};

/**
 * An exception row whose stored fingerprint still matches the live evidence;
 * `null` when the check cannot be excepted. A stale exception is not active.
 */
export const activeExceptionSql = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable,
): SQL | null => {
  if (!hasExceptions(entity) || !dataCheckExemptible[check]) return null;
  return sql`EXISTS (
  SELECT 1 FROM "DataException" dq_exception
  WHERE dq_exception."entityId" = ${t.id}
    AND dq_exception."check" = ${check}
    AND dq_exception."fingerprint" = ${fingerprintSql(entity, check, t)}
)`;
};

export const expectedCondition = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable = entryFor(entity).table,
): SQL => {
  const binding = bindingFor(entity, check);
  return group(binding.expected ? binding.expected(t) : sql`true`);
};

/** The check's `missing` predicate alone; a gap only where also expected. */
export const checkMissingCondition = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable = entryFor(entity).table,
): SQL => group(bindingFor(entity, check).missing(t));

/** `expected AND missing`, before any exception is applied. */
const rawGapCondition = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable = entryFor(entity).table,
): SQL =>
  group(
    sql`${expectedCondition(entity, check, t)} AND ${checkMissingCondition(entity, check, t)}`,
  );

/** A live gap: expected, missing, and not covered by an active exception. */
export const gapCondition = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable = entryFor(entity).table,
): SQL => {
  const active = activeExceptionSql(entity, check, t);
  const raw = rawGapCondition(entity, check, t);
  return active === null ? raw : group(sql`${raw} AND NOT ${active}`);
};

const orGroup = (conditions: readonly SQL[]): SQL =>
  conditions.length === 0
    ? group(sql`false`)
    : group(sql.join([...conditions], sql` OR `));

/** One integer per check and row; `QualityTerm.state` spelled for SQL. */
export const qualityStateCode = {
  not_applicable: 0,
  satisfied: 1,
  gap: 2,
  excepted: 3,
} as const satisfies Record<QualityTerm["state"], number>;

type StateTerm = Omit<QualityTerm, "state"> & { state: SQL };

const code = (state: QualityTerm["state"]) =>
  sql.raw(String(qualityStateCode[state]));

/**
 * `scoreQualityTerms` in SQL over one state column per check. `LEAST` skips
 * NULLs, so the weighted score (NULL without applicable weight) and the
 * lowest unresolved cap (NULL without a gap) combine exactly as the TS does.
 */
export const scoreFromStates = (terms: readonly StateTerm[]): SQL => {
  if (terms.length === 0) return sql`NULL::numeric`;
  const sum = (pick: (term: StateTerm) => SQL) =>
    sql.join(terms.map(pick), sql` + `);
  const expected = sum(
    (term) =>
      sql`CASE WHEN ${term.state} <> ${code("not_applicable")} THEN ${sql.raw(String(term.weight))} ELSE 0 END`,
  );
  const satisfied = sum(
    (term) =>
      sql`CASE WHEN ${term.state} IN (${code("satisfied")}, ${code("excepted")}) THEN ${sql.raw(String(term.weight))} ELSE 0 END`,
  );
  const caps = sql.join(
    terms.map(
      (term) =>
        sql`CASE WHEN ${term.state} = ${code("gap")} THEN ${sql.raw(String(term.scoreCap ?? DEFAULT_UNRESOLVED_SCORE_CAP))} END`,
    ),
    sql`, `,
  );
  return group(
    sql`LEAST(round(100.0 * (${satisfied}) / NULLIF((${expected}), 0), 2), ${caps})`,
  );
};

/** `scoreQualityTerms(...).status` in SQL; the precedence order is the TS one. */
export const statusFromStates = (terms: readonly StateTerm[]): SQL => {
  const any = (
    pick: (term: StateTerm) => boolean,
    state: QualityTerm["state"],
  ) =>
    orGroup(
      terms.filter(pick).map((term) => sql`${term.state} = ${code(state)}`),
    );
  const weighted = orGroup(
    terms
      .filter((term) => term.weight > 0)
      .map((term) => sql`${term.state} <> ${code("not_applicable")}`),
  );
  return group(sql`CASE
  WHEN ${any((term) => term.defect, "gap")} THEN 'defect'
  WHEN ${any(() => true, "gap")} THEN 'needs_data'
  WHEN NOT ${weighted} THEN 'not_assessed'
  WHEN ${any(() => true, "excepted")} THEN 'complete_with_exceptions'
  ELSE 'complete' END`);
};

/**
 * Each check's `expected`, `missing` and active-exception lookup evaluated
 * ONCE, as one state code, in an `OFFSET 0` subquery (the offset stops
 * Postgres pulling it up and re-inlining them). Postgres has no
 * common-subexpression elimination, and planner memory grows with every
 * inlined copy of a correlated policy subquery until the statement ends:
 * spelling each `expected` in several sums once helped one
 * FinancialTransaction list plan ~0.5 GB. The CASE also skips `missing` where
 * a check is not expected and the exception lookup where nothing is missing.
 */
const fromCheckStates = (
  entity: ScoredEntity,
  t: ScoredTable,
  select: (terms: readonly StateTerm[]) => SQL,
): SQL => {
  const checks = checksOf(entity);
  const inputs = sql.join(
    checks.map((check, index) => {
      const active = activeExceptionSql(entity, check, t);
      return sql`CASE
    WHEN ${expectedCondition(entity, check, t)} IS NOT TRUE THEN ${code("not_applicable")}
    WHEN ${checkMissingCondition(entity, check, t)} IS NOT TRUE THEN ${code("satisfied")}
    ${active === null ? sql`` : sql`WHEN ${active} THEN ${code("excepted")}`}
    ELSE ${code("gap")} END AS ${sql.identifier(`s${index}`)}`;
    }),
    sql`, `,
  );
  const terms = checks.map((check, index) => ({
    weight: dataCheckWeight[check],
    scoreCap: dataCheckScoreCap[check],
    defect: isDefectDataCheck(check),
    state: sql`dq_state.${sql.identifier(`s${index}`)}`,
  }));
  return group(
    sql`(SELECT ${select(terms)} FROM (SELECT ${inputs} OFFSET 0) dq_state)`,
  );
};

/**
 * The record's score: what `entity.records` returns and `ORDER BY
 * dataQuality` sorts on, equal to the hydrated `score`.
 */
export const scoreSql = (
  entity: ScoredEntity,
  t: ScoredTable = entryFor(entity).table,
): SQL => fromCheckStates(entity, t, scoreFromStates);

/** Authoritative pill tone; a defect cannot be inferred from the numeric score. */
export const statusSql = (
  entity: ScoredEntity,
  t: ScoredTable = entryFor(entity).table,
): SQL => fromCheckStates(entity, t, statusFromStates);

/** The `dataStatus` filter: the same status expression the row displays. */
export const statusCondition = (
  entity: ScoredEntity,
  status: DataQualityStatus,
  t: ScoredTable = entryFor(entity).table,
): SQL => group(sql`${statusSql(entity, t)} = ${status}`);

/** The alias a related row is evaluated under inside a roll-up subquery. */
const RELATED_ALIAS = "dq_r";

/**
 * A related entity's gap, rolled up: exists a live related row linked to `t`
 * that has the gap. The related table is aliased so its own bindings render
 * against `"dq_r"` — the same SQL the related entity's list filter uses.
 */
export const relatedGapCondition = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable = entryFor(entity).table,
): SQL => {
  const target = dataCheckEntity[check];
  const link = entryFor(entity).related?.[target];
  if (!link)
    throw new Error(`${entity} does not roll up ${target} data quality.`);
  // The inferred (not erased) entry, so the alias keeps its typed columns.
  const targetTable = dataQualityEntries[target].table;
  const related = alias(targetTable, RELATED_ALIAS);
  // A raw `${related}` renders only the alias; the FROM needs both names.
  const from = sql.raw(`"${getTableName(targetTable)}" "${RELATED_ALIAS}"`);
  return group(sql`EXISTS (
  SELECT 1 FROM ${from}
  WHERE ${liveQualityRow(related)}
    AND ${link(t, sql`${related.id}`)}
    AND ${gapCondition(target, check, related)}
)`);
};

/** Own checks first, then each related entity's, matching the filter options. */
export const filterableChecks = (
  entity: ScoredEntity,
): readonly DataCheck[] => [
  ...checksOf(entity),
  ...relatedDataQualityEntities[entity].flatMap((related) => checksOf(related)),
];

const oneOrManyList = <T extends z.ZodType<string>>(schema: T) =>
  z
    .union([schema, z.array(schema)])
    .optional()
    .transform((value) => (value === undefined ? [] : [value].flat()));

/** Only the two keys this module owns; every other filter passes through. */
const dataQualityFilterValues = z
  .object({
    dataStatus: oneOrManyList(dataQualityStatus),
    dataGap: oneOrManyList(z.string()),
  })
  .passthrough();

/**
 * The `dataStatus` / `dataGap` list predicates for one entity, from filters
 * the generated schema already validated. A `dataGap` naming a related
 * entity's check rolls up through `relatedGapCondition`; an unknown value
 * is dropped rather than matched against nothing.
 */
export const dataQualityFilterPredicates = <Filters extends object>(
  entity: ScoredEntity,
  t: ScoredTable,
  filters: Filters,
): SQL[] => {
  const values = dataQualityFilterValues.parse(filters);
  const predicates: SQL[] = [];
  const [status] = values.dataStatus;
  if (status !== undefined) {
    predicates.push(statusCondition(entity, status, t));
  }
  const own = dataChecksByEntity[entity];
  const related = relatedDataQualityEntities[entity].map(
    (target) => dataChecksByEntity[target],
  );
  const conditions = values.dataGap.flatMap((value) => {
    const ownCheck = own.safeParse(value);
    if (ownCheck.success) return [gapCondition(entity, ownCheck.data, t)];
    const relatedCheck = related
      .map((schema) => schema.safeParse(value))
      .find((parsed) => parsed.success);
    return relatedCheck?.success
      ? [relatedGapCondition(entity, relatedCheck.data, t)]
      : [];
  });
  if (conditions.length > 0) predicates.push(orGroup(conditions));
  return predicates;
};

const DATA_QUALITY_SORT = "dataQuality";

/** `resolve` for `buildOrderBy`: the score, asc = weakest row first. */
export const dataQualitySortResolver =
  (entity: ScoredEntity, t: ScoredTable) =>
  (sort: { orderBy: string; direction: string }): SQL[] | null =>
    sort.orderBy === DATA_QUALITY_SORT
      ? [
          // A not-assessed (null) score sorts after every scored row either way.
          sql`${scoreSql(entity, t)} ${sql.raw(sort.direction === "asc" ? "asc" : "desc")} NULLS LAST`,
        ]
      : null;
