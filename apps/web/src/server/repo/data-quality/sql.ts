import {
  type DataCheck,
  type DataQualityStatus,
  dataCheckEntity,
  dataChecksByEntity,
  dataCheckWeight,
  dataQualityExceptionEntities,
  dataQualityStatus,
  isDefectDataCheck,
  relatedDataQualityEntities,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { getTableName, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { type DataQualityEntries, dataQualityEntries } from "./entries";
import type { CheckBinding, EntityChecks, ScoredTable } from "./registry";

/**
 * Every builder here returns ONE parenthesized group. Callers embed these
 * under `NOT` (`dataStatus: "complete"` is `NOT anyGap`) and beside `OR`, and
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
  if (!binding.fingerprint)
    throw new Error(`${check} declares no fingerprint inputs.`);
  return sql`${check} || ':' || concat_ws('|', ${sql.join(
    [...binding.fingerprint(t)].map(fingerprintValue),
    sql`, `,
  )})`;
};

const activeExceptionSql = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable,
): SQL | null => {
  if (!hasExceptions(entity)) return null;
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

/** `expected AND missing`, before any exception is applied. */
export const rawGapCondition = (
  entity: ScoredEntity,
  check: DataCheck,
  t: ScoredTable = entryFor(entity).table,
): SQL => {
  const binding = bindingFor(entity, check);
  return group(
    sql`${expectedCondition(entity, check, t)} AND ${group(binding.missing(t))}`,
  );
};

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

export const defectCondition = (
  entity: ScoredEntity,
  t: ScoredTable = entryFor(entity).table,
): SQL =>
  orGroup(
    checksOf(entity)
      .filter(isDefectDataCheck)
      .map((check) => gapCondition(entity, check, t)),
  );

const missingCondition = (entity: ScoredEntity, t: ScoredTable): SQL =>
  orGroup(
    checksOf(entity)
      .filter((check) => !isDefectDataCheck(check))
      .map((check) => gapCondition(entity, check, t)),
  );

export const anyGapCondition = (
  entity: ScoredEntity,
  t: ScoredTable = entryFor(entity).table,
): SQL =>
  group(sql`${missingCondition(entity, t)} OR ${defectCondition(entity, t)}`);

export const statusCondition = (
  entity: ScoredEntity,
  status: DataQualityStatus,
  t: ScoredTable = entryFor(entity).table,
): SQL => {
  switch (status) {
    case "defect":
      return defectCondition(entity, t);
    case "needs_data":
      return group(
        sql`${missingCondition(entity, t)} AND NOT ${defectCondition(entity, t)}`,
      );
    case "complete":
      return group(sql`NOT ${anyGapCondition(entity, t)}`);
  }
};

/**
 * `100 * satisfied expected weight / expected weight`, 100 when nothing is
 * expected; an excepted check counts as satisfied because `gapCondition`
 * already excludes it. Same arithmetic as `calculateDataQualityScore`, so
 * `ORDER BY dataQualityScore` agrees with the hydrated `score`.
 */
export const scoreSql = (
  entity: ScoredEntity,
  t: ScoredTable = entryFor(entity).table,
): SQL => {
  const terms = checksOf(entity).map((check) => ({
    weight: dataCheckWeight[check],
    expected: expectedCondition(entity, check, t),
    gap: gapCondition(entity, check, t),
  }));
  const satisfied = sql.join(
    terms.map(
      ({ weight, expected, gap }) =>
        sql`CASE WHEN ${expected} AND NOT ${gap} THEN ${sql.raw(String(weight))} ELSE 0 END`,
    ),
    sql` + `,
  );
  const expected = sql.join(
    terms.map(
      ({ weight, expected }) =>
        sql`CASE WHEN ${expected} THEN ${sql.raw(String(weight))} ELSE 0 END`,
    ),
    sql` + `,
  );
  return group(
    sql`COALESCE(round(100.0 * (${satisfied}) / NULLIF((${expected}), 0), 2), 100)`,
  );
};

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
  WHERE ${related.deletedAt} IS NULL
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
          sql`${scoreSql(entity, t)} ${sql.raw(sort.direction === "asc" ? "asc" : "desc")}`,
        ]
      : null;
