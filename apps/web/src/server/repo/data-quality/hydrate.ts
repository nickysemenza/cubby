import {
  type DataCheck,
  type DataQuality,
  type DataQualityException,
  type DataQualityGap,
  dataCheckFacet,
  dataCheckKind,
  dataCheckMessage,
  dataCheckWeight,
  dataException,
  dataQualityExceptionEntities,
  dataQualityFacets,
  relatedDataQualityEntities,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { type EntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { uniq, uniqBy } from "es-toolkit";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/repo/database-helpers";

import {
  checksOf,
  entryFor,
  expectedCondition,
  fingerprintSql,
  rawGapCondition,
} from "./sql";

/**
 * A target's score is independent of related entities: a Purchase can be
 * complete on its own evidence while a linked Product remains incomplete.
 * Active exceptions are absent from `unresolvedGaps`, and therefore count as
 * satisfied. No applicable checks is deliberately a perfect score.
 */
export const calculateDataQualityScore = (
  expectedChecks: readonly DataCheck[],
  unresolvedGaps: readonly { check: DataCheck }[],
): number => {
  const expected = new Set(expectedChecks);
  const totalWeight = [...expected].reduce(
    (total, check) => total + dataCheckWeight[check],
    0,
  );
  if (totalWeight === 0) return 100;
  const unresolvedWeight = unresolvedGaps.reduce(
    (total, gap) =>
      expected.has(gap.check) ? total + dataCheckWeight[gap.check] : total,
    0,
  );
  const score =
    Math.round(((totalWeight - unresolvedWeight) / totalWeight) * 10_000) / 100;
  return Math.max(0, score);
};

const qualityStatus = (
  gaps: readonly Pick<DataQualityGap, "kind">[],
): DataQuality["status"] =>
  gaps.some((gap) => gap.kind === "defect")
    ? "defect"
    : gaps.length > 0
      ? "needs_data"
      : "complete";

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
    sql`${rawGapCondition(entity, check, t)} AS ${sql.identifier(gapKey(index))}`,
    ...(withFingerprints
      ? [
          sql`${fingerprintSql(entity, check, t)} AS ${sql.identifier(fingerprintKey(index))}`,
        ]
      : []),
  ]);
  const exceptions =
    withFingerprints && entry.exceptions
      ? sql`${entry.exceptions(t)}`
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
    if (row[gapKey(index)] !== true) return;
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
    // Only these two tables store exceptions; the exception schemas still
    // name purchase|product until the generic store lands (docs/todos.md).
    entity !== "purchase" && entity !== "product"
      ? []
      : row.exceptions.map(({ fingerprint, ...exception }) => ({
          ...exception,
          targetType: entity,
          targetId,
          state:
            fingerprint !== undefined &&
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
  const facets = dataQualityFacets[entity].map((name) => {
    const facetGaps = gaps.filter((gap) => gap.facet === name);
    return { name, status: qualityStatus(facetGaps), gaps: facetGaps };
  });
  return {
    status: qualityStatus(gaps),
    score: calculateDataQualityScore(expectedChecks, gaps),
    facets,
    gaps,
    exceptions,
  };
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
  const relatedQualities = new Map<ScoredEntity, Map<string, DataQuality>>();
  for (const target of relatedDataQualityEntities[entity]) {
    const targetIds = uniq(
      [...relatedIds.values()].flatMap((links) =>
        links.filter((link) => link.entity === target).map((link) => link.id),
      ),
    );
    relatedQualities.set(
      target,
      await loadDataQualities(
        db,
        target,
        // SAFETY: ids came from the related table's own id column.
        targetIds as EntityId<typeof target>[],
      ),
    );
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
