import { scoredEntities, type ScoredEntity } from "@cubby/schemas/data-quality";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { storedEntryFor } from "~/server/generic/data-quality/repo/entry";
import { DERIVED_DRAIN } from "~/server/generic/derived/repo/drain";
import { markWorkFrom } from "~/server/generic/jobs/repo/work-items";
import { drainStoredDerived } from "~/server/testing/background-queue";

/**
 * Explicit publication for read-contract fixtures, including deliberately raw
 * input edits a declared trigger does not see: mark every record of `kind`
 * and drain stored derived values (ADR 0021).
 */
export async function publishQualityFixtures(db: Database, kind: ScoredEntity) {
  const table = storedEntryFor(kind).table;
  await markWorkFrom(
    db,
    DERIVED_DRAIN,
    sql`SELECT ${`${kind}.dataQuality`}, t.id, 0, NULL::text FROM ${table} t`,
    { wake: false },
  );
  await drainStoredDerived(db);
}

/** Publishes every stored-mode entity, for reads that filter on published rows. */
export async function publishAllQualityFixtures(db: Database) {
  for (const kind of scoredEntities) await publishQualityFixtures(db, kind);
}

/** A record's stored quality value (ADR 0021), or undefined before publication. */
export async function storedQuality(
  db: Database,
  entityId: string,
): Promise<
  | {
      rulesVersion: number;
      checks: Record<string, string>;
    }
  | undefined
> {
  const result = await unwrapDb(db).execute(sql`
    SELECT jsonb_build_object('rulesVersion', "rulesVersion", 'checks', checks) AS value FROM "QualitySnapshot"
     WHERE "entityId" = ${entityId}`);
  const [row] = z
    .array(
      z.object({
        value: z.object({
          rulesVersion: z.number(),
          checks: z.record(z.string(), z.string()),
        }),
      }),
    )
    .parse(result.rows);
  return row?.value;
}

/** Ids with stored quality of `kind`, for publication assertions. */
export async function storedQualityIds(
  db: Database,
  kind?: ScoredEntity,
): Promise<string[]> {
  const result = await unwrapDb(db).execute(
    kind
      ? sql`SELECT "entityId"::text AS id FROM "QualitySnapshot" WHERE kind = ${kind} ORDER BY 1`
      : sql`SELECT "entityId"::text AS id FROM "QualitySnapshot" ORDER BY 1`,
  );
  return z
    .array(z.object({ id: z.string() }))
    .parse(result.rows)
    .map((row) => row.id);
}
