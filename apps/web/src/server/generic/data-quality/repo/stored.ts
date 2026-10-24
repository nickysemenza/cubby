import {
  dataCheck,
  dataCheckExemptible,
  dataCheckKind,
  dataCheckScoreCap,
  dataCheckWeight,
  dataChecksByEntity,
  dataException,
  scoreQualityTerms,
  type QualityTerm,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { entityQualityCheckState } from "@cubby/schemas/data-quality-shape";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  entityQuality,
  entityQualityCheck,
} from "~/server/db/entity-quality-schema";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { dataExceptionRecord } from "~/server/db/retained-tables";
import { liveQualityRow } from "~/server/generic/data-quality/repo/registry";
import type { ScoredTable } from "~/server/generic/data-quality/repo/registry";

import { dataQualityEntries, storedEntryFor } from "./entries";
import type { QualityEvaluation, StoredEntityChecks } from "./stored-registry";

type ReaderDb = Database | DrizzleTransaction;
export type StoredEvaluation = QualityEvaluation & {
  exceptions: z.infer<typeof dataException>[];
};

const storedQualityTerms = (
  checks: QualityEvaluation["checks"],
): QualityTerm[] =>
  Object.entries(checks).map(([key, state]) => {
    const check = dataCheck.parse(key);
    return {
      weight: dataCheckWeight[check],
      scoreCap: dataCheckScoreCap[check],
      defect: dataCheckKind[check] === "defect",
      state:
        state === "pass"
          ? "satisfied"
          : state === "waived"
            ? "excepted"
            : state,
    };
  });

async function loadExceptions(
  db: ReaderDb,
  kind: ScoredEntity,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  return unwrapDb(db)
    .select()
    .from(dataExceptionRecord)
    .where(
      and(
        eq(dataExceptionRecord.entityKind, kind),
        inArray(dataExceptionRecord.entityId, [...ids]),
        inArray(dataExceptionRecord.check, [
          ...dataChecksByEntity[kind].options,
        ]),
      ),
    );
}

/** Stored-mode waivers are durable member decisions; legacy fingerprints are ignored. */
export async function evaluateLiveQuality(
  db: ReaderDb,
  entry: StoredEntityChecks<ScoredEntity, ScoredTable>,
  ids: readonly string[],
): Promise<StoredEvaluation[]> {
  if (!ids.length) return [];
  const [rows, exceptions] = await Promise.all([
    entry.evaluate(db, ids),
    loadExceptions(db, entry.entity, ids),
  ]);
  return rows.map((row) => {
    const recorded = exceptions
      .filter((exception) => exception.entityId === row.id)
      .map((exception) => dataException.parse(exception));
    const waived = new Set(
      recorded.filter((e) => dataCheckExemptible[e.check]).map((e) => e.check),
    );
    return {
      ...row,
      exceptions: recorded,
      checks: Object.fromEntries(
        Object.entries(row.checks).map(([key, state]) => [
          key,
          state === "gap" && waived.has(dataCheck.parse(key))
            ? "waived"
            : state,
        ]),
      ),
    };
  });
}

/** Missing publications are unassessed, never synchronously repaired by a read. */
export async function loadPublishedQuality(
  db: ReaderDb,
  kind: ScoredEntity,
  ids: readonly string[],
): Promise<StoredEvaluation[]> {
  if (!ids.length) return [];
  const { table: t } = dataQualityEntries[kind];
  const [result, exceptions] = await Promise.all([
    unwrapDb(db)
      .execute(sql`SELECT ${t.id}::text AS id, ${t.shortcode} AS shortcode,
      q.score, coalesce(jsonb_object_agg(c."checkKey", c.state) FILTER (WHERE c."checkKey" IS NOT NULL), '{}'::jsonb) AS checks
      FROM ${t} LEFT JOIN ${entityQuality} q ON q."entityId" = ${t.id} AND q.kind = ${kind}
      LEFT JOIN ${entityQualityCheck} c ON c."entityId" = ${t.id} AND c.kind = ${kind}
      WHERE ${t.id} = ANY(${uuidArrayParam(ids)}) AND ${liveQualityRow(t)}
      GROUP BY ${t.id}, ${t.shortcode}, q.score`),
    loadExceptions(db, kind, ids),
  ]);
  return z
    .array(
      z.object({
        id: z.string(),
        shortcode: z.string(),
        score: z.number().nullable(),
        checks: z.record(z.string(), entityQualityCheckState),
      }),
    )
    .parse(result.rows)
    .map((row) => ({
      ...row,
      checks: Object.fromEntries(
        dataChecksByEntity[kind].options.map((key) => [
          key,
          row.checks[key] ?? "not_applicable",
        ]),
      ),
      exceptions: exceptions
        .filter((exception) => exception.entityId === row.id)
        .map((exception) => dataException.parse(exception)),
    }));
}

export type QualityPublication = {
  entityId: string;
  kind: ScoredEntity;
  rulesVersion: number;
  score: number | null;
  checks: QualityEvaluation["checks"];
};

export async function prepareQualityPublications(
  db: ReaderDb,
  kind: ScoredEntity,
  ids: readonly string[],
): Promise<QualityPublication[]> {
  const entry = storedEntryFor(kind);
  if (!entry) throw new Error(`${kind} has no stored quality evaluator`);
  // Loaders need not promise source-row order; publication comparisons do.
  return (await evaluateLiveQuality(db, entry, ids))
    .map((row) => ({
      entityId: row.id,
      kind,
      rulesVersion: entry.rulesVersion,
      score: scoreQualityTerms(storedQualityTerms(row.checks)).score,
      checks: row.checks,
    }))
    .sort((a, b) => a.entityId.localeCompare(b.entityId));
}

/** Compare only persisted outcomes and version, not a second stored input fingerprint. */
export async function changedQualityIds(
  db: ReaderDb,
  ids: readonly string[],
  rows: readonly QualityPublication[],
): Promise<string[]> {
  if (!ids.length) return [];
  const tx = unwrapDb(db);
  const existing = await tx
    .select()
    .from(entityQuality)
    .where(inArray(entityQuality.entityId, [...ids]));
  const checks = await tx
    .select()
    .from(entityQualityCheck)
    .where(inArray(entityQualityCheck.entityId, [...ids]));
  const byId = new Map(rows.map((row) => [row.entityId, row]));
  return ids.filter((id) => {
    const row = byId.get(id);
    const old = existing.find((item) => item.entityId === id);
    if (!row)
      return old !== undefined || checks.some((check) => check.entityId === id);
    const oldChecks = checks.filter((check) => check.entityId === id);
    const nextChecks = new Map(Object.entries(row.checks));
    return (
      !old ||
      old.score !== row.score ||
      old.kind !== row.kind ||
      old.rulesVersion !== row.rulesVersion ||
      oldChecks.length !== Object.keys(row.checks).length ||
      oldChecks.some((check) => nextChecks.get(check.checkKey) !== check.state)
    );
  });
}

/** Publication is called only inside the family Job's validated transaction. */
export async function publishQualityRows(
  db: ReaderDb,
  ids: readonly string[],
  rows: readonly QualityPublication[],
): Promise<string[]> {
  const changed = await changedQualityIds(db, ids, rows);
  if (!changed.length) return changed;
  const tx = unwrapDb(db);
  await tx
    .delete(entityQualityCheck)
    .where(inArray(entityQualityCheck.entityId, changed));
  await tx
    .delete(entityQuality)
    .where(inArray(entityQuality.entityId, changed));
  const next = rows.filter((row) => changed.includes(row.entityId));
  if (!next.length) return changed;
  const computedAt = new Date();
  await tx
    .insert(entityQuality)
    .values(
      next.map(({ checks: _checks, ...row }) => ({ ...row, computedAt })),
    );
  const values = next.flatMap((row) =>
    Object.entries(row.checks).map(([checkKey, state]) => ({
      entityId: row.entityId,
      kind: row.kind,
      checkKey,
      state,
    })),
  );
  if (values.length) await tx.insert(entityQualityCheck).values(values);
  return changed;
}
