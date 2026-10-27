import {
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
import { entityQualityCheckState } from "@cubby/schemas/data-quality-shape";
import { getTableName, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { sqlEnumConstant } from "~/server/db/sql-enum";
import {
  liveQualityRow,
  type ScoredTable,
} from "~/server/generic/data-quality/repo/registry";

import { storedEntryFor } from "./entry";
import { storedCheckStateSql, storedScoreSql } from "./stored-sql";

/**
 * Every builder here returns ONE parenthesized group. Callers embed these
 * under `NOT` and beside `OR`, and
 * `NOT a AND b` once emptied a production worklist because the group was a
 * bare conjunction. The unit test asserts the shape on the rendered SQL.
 *
 * Predicates read the published `dataQuality` derived value (ADR 0021) through
 * indexed per-row lookups, so they stay valid under any FROM clause.
 */
const group = (inner: SQL): SQL => sql`(${inner})`;

export const checksOf = (entity: ScoredEntity): readonly DataCheck[] =>
  dataChecksByEntity[entity].options;

const state = (name: z.infer<typeof entityQualityCheckState>) =>
  sqlEnumConstant(entityQualityCheckState, name);

/** A published waiver; `null` when the check cannot be waived. */
export const activeExceptionSql = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable,
): SQL | null =>
  dataQualityExceptionEntities[entity] && dataCheckExemptible[check]
    ? group(sql`${storedCheckStateSql(entity, check, t)} = ${state("waived")}`)
    : null;

/** The check applies to the row; an unpublished row applies nowhere. */
export const expectedCondition = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable = storedEntryFor(entity).table,
): SQL =>
  group(
    sql`coalesce(${storedCheckStateSql(entity, check, t)}, ${state("not_applicable")}) <> ${state("not_applicable")}`,
  );

/** An unwaived published gap. */
export const gapCondition = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable = storedEntryFor(entity).table,
): SQL =>
  group(
    sql`coalesce(${storedCheckStateSql(entity, check, t)} = ${state("gap")}, false)`,
  );

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
  WHEN ${any((term) => term.defect, "gap")} THEN ${sqlEnumConstant(dataQualityStatus, "defect")}
  WHEN ${any(() => true, "gap")} THEN ${sqlEnumConstant(dataQualityStatus, "needs_data")}
  WHEN NOT ${weighted} THEN ${sqlEnumConstant(dataQualityStatus, "not_assessed")}
  WHEN ${any(() => true, "excepted")} THEN ${sqlEnumConstant(dataQualityStatus, "complete_with_exceptions")}
  ELSE ${sqlEnumConstant(dataQualityStatus, "complete")} END`);
};

/**
 * The record's published score: what `entity.records` returns and `ORDER BY
 * dataQuality` sorts on.
 */
export const scoreSql = (
  entity: ScoredEntity,
  t: ScoredTable = storedEntryFor(entity).table,
): SQL => storedScoreSql(entity, t);

/** Authoritative pill tone; a defect cannot be inferred from the numeric score. */
export const statusSql = (
  entity: ScoredEntity,
  t: ScoredTable = storedEntryFor(entity).table,
): SQL =>
  statusFromStates(
    checksOf(entity).map((check) => ({
      weight: dataCheckWeight[check],
      scoreCap: dataCheckScoreCap[check],
      defect: isDefectDataCheck(check),
      state: sql`CASE ${storedCheckStateSql(entity, check, t)}
      WHEN ${state("pass")} THEN ${code("satisfied")} WHEN ${state("gap")} THEN ${code("gap")}
      WHEN ${state("waived")} THEN ${code("excepted")} ELSE ${code("not_applicable")} END`,
    })),
  );

/** The `dataStatus` filter: the same status expression the row displays. */
export const statusCondition = (
  entity: ScoredEntity,
  status: DataQualityStatus,
  t: ScoredTable = storedEntryFor(entity).table,
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
  t: ScoredTable = storedEntryFor(entity).table,
): SQL => {
  const target = dataCheckEntity[check];
  const link = storedEntryFor(entity).related?.[target];
  if (!link)
    throw new Error(`${entity} does not roll up ${target} data quality.`);
  const targetTable = storedEntryFor(target).table;
  const aliased: unknown = alias(targetTable, RELATED_ALIAS);
  // SAFETY: alias preserves the scored table's id, shortcode, and tombstone columns.
  const related = aliased as ScoredTable;
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
// `dataQualityExclude` / `dataGapsExclude` are the filters' generated
// Exclude keys (named for their column ids).
const dataQualityFilterValues = z
  .object({
    dataStatus: oneOrManyList(dataQualityStatus),
    dataGap: oneOrManyList(z.string()),
    dataQualityExclude: oneOrManyList(dataQualityStatus),
    dataGapsExclude: oneOrManyList(z.string()),
  })
  .passthrough();

/**
 * The `dataStatus` / `dataGap` list predicates for one entity, from filters
 * the generated schema already validated. Each is any-of. A `dataGap` naming a related
 * entity's check rolls up through `relatedGapCondition`; an unknown value
 * is dropped rather than matched against nothing.
 */
export const dataQualityFilterPredicates = <Filters extends object>(
  entity: ScoredEntity,
  t: ScoredTable,
  filters: Filters,
): SQL[] => {
  const values = dataQualityFilterValues.parse(filters);
  const statuses = (picked: readonly DataQualityStatus[]) =>
    picked.length === 0
      ? []
      : [orGroup(picked.map((status) => statusCondition(entity, status, t)))];
  const own = dataChecksByEntity[entity];
  const related = relatedDataQualityEntities[entity].map(
    (target) => dataChecksByEntity[target],
  );
  const gaps = (picked: readonly string[]) => {
    const conditions = picked.flatMap((value) => {
      const ownCheck = own.safeParse(value);
      if (ownCheck.success) return [gapCondition(entity, ownCheck.data, t)];
      const relatedCheck = related
        .map((schema) => schema.safeParse(value))
        .find((parsed) => parsed.success);
      return relatedCheck?.success
        ? [relatedGapCondition(entity, relatedCheck.data, t)]
        : [];
    });
    return conditions.length > 0 ? [orGroup(conditions)] : [];
  };
  // Exclude negates the include predicate; an unassessed row stays.
  const excluded = (include: SQL[]) =>
    include.length === 0 ? [] : [sql`NOT COALESCE((${include[0]}), false)`];
  return [
    ...statuses(values.dataStatus),
    ...gaps(values.dataGap),
    ...excluded(statuses(values.dataQualityExclude)),
    ...excluded(gaps(values.dataGapsExclude)),
  ];
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
