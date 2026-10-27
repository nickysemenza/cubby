import { scoredEntities, type ScoredEntity } from "@cubby/schemas/data-quality";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { storedEntryFor } from "~/server/generic/data-quality/repo/entry";
import { drainStoredDerived } from "~/server/testing/background-queue";

/**
 * Explicit publication for read-contract fixtures, including deliberately raw
 * input edits a declared trigger does not see: mark every record of `kind`
 * and drain stored derived values (ADR 0021).
 */
export async function publishQualityFixtures(db: Database, kind: ScoredEntity) {
  const table = storedEntryFor(kind).table;
  await unwrapDb(db).execute(sql`
    INSERT INTO "DerivedDirty" (target, ref, priority)
    SELECT ${`${kind}.dataQuality`}, t.id, 0 FROM ${table} t
    ON CONFLICT (target, ref) DO UPDATE SET ticket = nextval('"DerivedTicket"')`);
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
      score: number | null;
      checks: Record<string, string>;
    }
  | undefined
> {
  const result = await unwrapDb(db).execute(sql`
    SELECT value FROM "DerivedValue"
     WHERE "entityId" = ${entityId} AND key = 'dataQuality'`);
  const [row] = z
    .array(
      z.object({
        value: z.object({
          rulesVersion: z.number(),
          score: z.number().nullable(),
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
      ? sql`SELECT "entityId"::text AS id FROM "DerivedValue" WHERE key = 'dataQuality' AND kind = ${kind} ORDER BY 1`
      : sql`SELECT "entityId"::text AS id FROM "DerivedValue" WHERE key = 'dataQuality' ORDER BY 1`,
  );
  return z
    .array(z.object({ id: z.string() }))
    .parse(result.rows)
    .map((row) => row.id);
}
