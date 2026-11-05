import {
  dataCheck,
  dataCheckExemptible,
  dataChecksByEntity,
  dataException,
  type ScoredEntity,
} from "@cubby/schemas/data-quality";
import { entityQualityCheckState } from "@cubby/schemas/data-quality-shape";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { dataExceptionRecord } from "~/server/db/retained-tables";
import { liveQualityRow } from "~/server/generic/data-quality/repo/registry";
import type { ScoredTable } from "~/server/generic/data-quality/repo/registry";

import { storedEntryFor } from "./entry";
import type { QualityEvaluation, StoredEntityChecks } from "./stored-registry";

type ReaderDb = Database | DrizzleTransaction;
export type StoredEvaluation = QualityEvaluation & {
  exceptions: z.infer<typeof dataException>[];
};

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
  const { table: t } = storedEntryFor(kind);
  const [result, exceptions] = await Promise.all([
    unwrapDb(db)
      .execute(sql`SELECT ${t.id}::text AS id, ${t.shortcode} AS shortcode,
      coalesce(q.checks, '{}'::jsonb) AS checks
      FROM ${t} LEFT JOIN "QualitySnapshot" q ON q."entityId" = ${t.id} AND q.kind = ${kind}
      WHERE ${t.id} = ANY(${uuidArrayParam(ids)}) AND ${liveQualityRow(t)}`),
    loadExceptions(db, kind, ids),
  ]);
  return z
    .array(
      z.object({
        id: z.string(),
        shortcode: z.string(),
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
  checks: QualityEvaluation["checks"];
};

export async function prepareQualityPublications(
  db: ReaderDb,
  kind: ScoredEntity,
  ids: readonly string[],
): Promise<QualityPublication[]> {
  const entry = storedEntryFor(kind);
  // Loaders need not promise source-row order; publication comparisons do.
  return (await evaluateLiveQuality(db, entry, ids))
    .map((row) => ({
      entityId: row.id,
      kind,
      rulesVersion: entry.rulesVersion,
      checks: row.checks,
    }))
    .sort((a, b) => a.entityId.localeCompare(b.entityId));
}

/** Publish changed check states, and remove absent/tombstoned outputs from the same page. */
export async function publishQualitySnapshots(
  db: ReaderDb,
  {
    kind,
    ids,
    rows,
  }: {
    kind: ScoredEntity;
    ids: readonly string[];
    rows: readonly QualityPublication[];
  },
): Promise<readonly string[]> {
  if (!ids.length) return [];
  const result = await unwrapDb(db).execute(sql`
    WITH input AS MATERIALIZED (
      SELECT * FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS r("entityId" uuid, kind text, "rulesVersion" integer, checks jsonb)
    ), removed AS (
      DELETE FROM "QualitySnapshot" q WHERE q.kind = ${kind} AND q."entityId" = ANY(${uuidArrayParam(ids)})
        AND (NOT EXISTS (SELECT 1 FROM input i WHERE i."entityId" = q."entityId")
          OR NOT EXISTS (SELECT 1 FROM "Entity" live WHERE live.id = q."entityId" AND ${notDeleted("live")}))
      RETURNING q."entityId"
    ), written AS (
      INSERT INTO "QualitySnapshot" ("entityId", kind, "rulesVersion", checks, "computedAt")
      SELECT r."entityId", r.kind, r."rulesVersion", r.checks, now() AT TIME ZONE 'UTC'
      FROM input r JOIN "Entity" live ON live.id = r."entityId" AND live.kind = r.kind
        AND ${notDeleted("live")}
      ON CONFLICT ("entityId") DO UPDATE SET
        kind = EXCLUDED.kind, "rulesVersion" = EXCLUDED."rulesVersion",
        checks = EXCLUDED.checks, "computedAt" = EXCLUDED."computedAt"
      WHERE ("QualitySnapshot".kind, "QualitySnapshot"."rulesVersion", "QualitySnapshot".checks)
        IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED."rulesVersion", EXCLUDED.checks)
      RETURNING "entityId"
    ) SELECT "entityId" FROM written UNION ALL SELECT "entityId" FROM removed`);
  return z
    .array(z.object({ entityId: z.string() }))
    .parse(result.rows)
    .map((row) => row.entityId);
}
