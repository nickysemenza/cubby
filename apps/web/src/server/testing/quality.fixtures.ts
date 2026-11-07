import { scoredEntities, type ScoredEntity } from "@cubby/schemas/data-quality";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { qualityDerivedComputes } from "~/server/generic/data-quality/repo/derived";
import { storedEntryFor } from "~/server/generic/data-quality/repo/entry";
import { isDerivedSink } from "~/server/generic/derived/repo/compute";

/** Publish this capability only, preserving deliberately seeded snapshots of other families. */
export async function publishQualityFixtures(db: Database, kind: ScoredEntity) {
  const adapter = qualityDerivedComputes[`quality.${kind}`];
  if (!adapter || !isDerivedSink(adapter))
    throw new Error(`Missing quality fixture adapter: ${kind}`);
  const table = storedEntryFor(kind).table;
  const ids = z
    .array(z.object({ id: z.uuid() }))
    .parse(
      await unwrapDb(db).execute(
        sql`SELECT t.id FROM ${table} t ORDER BY t.id`,
        "objects",
      ),
    )
    .map((row) => row.id);
  for (let start = 0; start < ids.length; start += 200) {
    const page = ids.slice(start, start + 200);
    const prepared = await adapter.prepare(db, page);
    await adapter.publish(db, page, prepared);
  }
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
  const result = await unwrapDb(db).execute(
    sql`
    SELECT jsonb_build_object('rulesVersion', "rulesVersion", 'checks', checks) AS value FROM "QualitySnapshot"
     WHERE "entityId" = ${entityId}`,
    "objects",
  );
  const [row] = z
    .array(
      z.object({
        value: z.object({
          rulesVersion: z.number(),
          checks: z.record(z.string(), z.string()),
        }),
      }),
    )
    .parse(result);
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
    "objects",
  );
  return z
    .array(z.object({ id: z.string() }))
    .parse(result)
    .map((row) => row.id);
}
