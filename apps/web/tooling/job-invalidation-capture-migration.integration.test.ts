import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Review finding: the capture table started empty, so a marker already ahead
// of its Job at the cutover had no capture history. The first later capture
// replaced the marker's write time, and health lost the legacy pending age.
it("keeps the pending start of markers already ahead of their Job at the cutover", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0029_image_job_lanes" });
    const families = [
      // [family, observedRevision, marker revision, marker age in minutes]
      ["search", 3, 4, 45],
      ["recipes", 5, 5, 120],
      ["conversions", null, 2, 30],
    ] as const;
    for (const [family, observed, revision, minutes] of families) {
      await client.query(
        `INSERT INTO "Job" (key, kind, input, state, "observedRevision")
         VALUES ($1, 'refresh.family', $2, 'completed', $3)
         ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state,
           "observedRevision" = EXCLUDED."observedRevision"`,
        [`refresh:${family}`, JSON.stringify({ family }), observed],
      );
      await client.query(
        `INSERT INTO "JobInvalidation" (key, revision, "restartsPass", "updatedAt")
         VALUES ($1, $2, true, timezone('UTC', now()) - $3 * interval '1 minute')
         ON CONFLICT (key) DO UPDATE SET revision = EXCLUDED.revision,
           "updatedAt" = EXCLUDED."updatedAt"`,
        [`refresh:${family}`, revision, minutes],
      );
    }
    await migrateDatabase(db, { through: "0030_job_invalidation_capture" });
    const captures = async () =>
      (
        await client.query<{ key: string; revision: number; matches: boolean }>(
          `SELECT c.key, c.revision::int AS revision, c."capturedAt" = m."updatedAt" AS matches
           FROM "JobInvalidationCapture" c JOIN "JobInvalidation" m USING (key)
           WHERE c.key LIKE 'refresh:%' ORDER BY c.key, c.revision`,
        )
      ).rows;
    // One row per pending marker, dated by the marker's last write; an
    // observed marker gets none.
    expect(await captures()).toEqual([
      { key: "refresh:conversions", revision: 2, matches: true },
      { key: "refresh:search", revision: 4, matches: true },
    ]);
    // A later capture (`recordJobInvalidation`) moves the marker; the
    // outstanding interval still starts at the legacy capture.
    await client.query(
      `WITH marker AS (
         UPDATE "JobInvalidation" SET revision = revision + 1, "updatedAt" = timezone('UTC', now())
         WHERE key = 'refresh:search' RETURNING key, revision, "updatedAt")
       INSERT INTO "JobInvalidationCapture" (key, revision, "capturedAt")
       SELECT key, revision, "updatedAt" FROM marker`,
    );
    const pending = await client.query<{ minutes: number }>(
      `SELECT round(extract(epoch FROM timezone('UTC', now()) - min(c."capturedAt")) / 60)::int AS minutes
       FROM "JobInvalidationCapture" c JOIN "Job" j USING (key)
       WHERE c.key = 'refresh:search' AND c.revision > coalesce(j."observedRevision", 0)`,
    );
    expect(pending.rows[0]?.minutes).toBe(45);
  });
});

it("retires late catalog wrappers per table and keeps the no-op if another function still references it", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0098_source_occurrence_ownership" });
    await client.query(`
      CREATE TABLE "SyntheticLateEvidence" (value text);
      CREATE TABLE "SyntheticEmptyEvidence" (value text);
      INSERT INTO "SyntheticLateEvidence" VALUES ('Synthetic retained evidence');
      INSERT INTO "SyntheticEmptyEvidence" VALUES ('Synthetic empty-wrapper evidence');
      CREATE FUNCTION derived_mark_synthetic_late() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM derived_mark('synthetic.late', ARRAY[]::uuid[], 'Synthetic'); RETURN NULL; END $$;
      CREATE FUNCTION derived_mark_synthetic_empty() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$;
      CREATE TRIGGER "SyntheticLateEvidence_derived_mark" AFTER INSERT ON "SyntheticLateEvidence"
        FOR EACH ROW EXECUTE FUNCTION derived_mark_synthetic_late();
      CREATE TRIGGER "SyntheticEmptyEvidence_derived_mark" AFTER INSERT ON "SyntheticEmptyEvidence"
        FOR EACH ROW EXECUTE FUNCTION derived_mark_synthetic_empty();
      CREATE FUNCTION synthetic_unrelated_trigger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RETURN NULL; END $$;
      CREATE TRIGGER synthetic_unrelated AFTER INSERT ON "SyntheticLateEvidence"
        FOR EACH ROW EXECUTE FUNCTION synthetic_unrelated_trigger();
      CREATE FUNCTION synthetic_marker_caller() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN PERFORM derived_mark('synthetic.caller', ARRAY[]::uuid[], 'Synthetic'); END $$;
    `);
    const preserved = async () =>
      (
        await client.query(`SELECT jsonb_build_object(
      'late', (SELECT jsonb_agg(to_jsonb(e)) FROM "SyntheticLateEvidence" e),
      'empty', (SELECT jsonb_agg(to_jsonb(e)) FROM "SyntheticEmptyEvidence" e),
      'conversion', (SELECT count(*) FROM "ProductConversionCoverage"),
      'work', (SELECT count(*) FROM "WorkItem")) AS value`)
      ).rows;
    const before = await preserved();
    await expect(
      migrateDatabase(db, { through: "0099_retire_derived_markers" }),
    ).rejects.toMatchObject({
      cause: {
        code: "P0001",
        message:
          "Other functions reference shared marker; all functions retained",
      },
    });
    expect(await preserved()).toEqual(before);
    expect(
      (
        await client.query(`SELECT
      to_regprocedure('public.derived_mark(text,uuid[],text)') IS NOT NULL AS retained,
      (SELECT count(*)::int FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE p.proname LIKE 'derived\\_mark\\_%' ESCAPE '\\') AS triggers,
      (SELECT count(*)::int FROM pg_trigger WHERE tgname='synthetic_unrelated') AS unrelated`)
      ).rows,
    ).toEqual([{ retained: true, triggers: 0, unrelated: 1 }]);
    await client.query(
      "SELECT synthetic_marker_caller(); DROP FUNCTION synthetic_marker_caller()",
    );
    // Replay after committed table drops, with the shared no-op still present.
    await migrateDatabase(db, {
      through: "0099_retire_derived_markers",
    });
    expect(await preserved()).toEqual(before);
    expect(
      (
        await client.query(`SELECT
      to_regprocedure('public.derived_mark(text,uuid[],text)') IS NULL AS retired,
      to_regprocedure('public.cubby_retire_marker_table()') IS NULL AS helper_removed,
      to_regclass('public."ProductConversionCoverage"') IS NOT NULL AS snapshot_retained`)
      ).rows,
    ).toEqual([
      { retired: true, helper_removed: true, snapshot_retained: true },
    ]);
    await client.query(
      `INSERT INTO "SyntheticLateEvidence" VALUES ('Synthetic post-retirement write')`,
    );
    expect(
      (
        await client.query(
          'SELECT count(*)::int AS count FROM "SyntheticLateEvidence"',
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
  });
});
