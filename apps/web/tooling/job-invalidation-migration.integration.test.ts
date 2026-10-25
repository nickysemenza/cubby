import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Existing family Jobs must start observed, so the first capture after the
// cutover writes only the marker row, their execution facts stay intact, and
// no invalidation pending before the cutover (a queued Job with a bumped
// generation) is dropped.
it("starts existing refresh families observed and keeps every pending pass", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0027_email_link_event_index",
    });
    const lease = "00000000-0000-4000-8000-000000000071";
    const families = [
      // [family, state, generation, cursor, lease]
      ["search", "completed", 4, null, null],
      ["quality", "queued", 7, { at: "synthetic" }, null],
      ["recipes", "running", 3, { at: "synthetic" }, lease],
      // A capture before the cutover bumped this generation and requeued it.
      ["conversions", "queued", 9, null, null],
    ] as const;
    for (const [family, state, generation, cursor, token] of families)
      await client.query(
        `INSERT INTO "Job" (key, kind, input, state, generation, cursor, "leaseToken", "leaseExpiresAt", "availableAt")
         VALUES ($1, 'refresh.family', $2, $3, $4, $5, $6::uuid,
           CASE WHEN $6::uuid IS NULL THEN NULL ELSE timezone('UTC', now()) + interval '5 minutes' END,
           timezone('UTC', now()) - interval '1 minute')
         ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state, generation = EXCLUDED.generation,
           cursor = EXCLUDED.cursor, "leaseToken" = EXCLUDED."leaseToken",
           "leaseExpiresAt" = EXCLUDED."leaseExpiresAt", "availableAt" = EXCLUDED."availableAt"`,
        [
          `refresh:${family}`,
          JSON.stringify({ family }),
          state,
          generation,
          cursor === null ? null : JSON.stringify(cursor),
          token,
        ],
      );
    const executionColumns = `key, state, generation, cursor, "leaseToken", "leaseExpiresAt", "availableAt"`;
    const before = await client.query(
      `SELECT ${executionColumns} FROM "Job" WHERE key IN ('refresh:search', 'refresh:quality', 'refresh:recipes', 'refresh:conversions') ORDER BY key`,
    );
    await migrateDatabase(db, { through: "0028_job_invalidation" });
    expect(
      (
        await client.query(
          `SELECT ${executionColumns} FROM "Job" WHERE key IN ('refresh:search', 'refresh:quality', 'refresh:recipes', 'refresh:conversions') ORDER BY key`,
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await client.query(
          `SELECT j.key, j."observedRevision"::int AS observed, m.revision::int AS revision, m."restartsPass"
           FROM "Job" j JOIN "JobInvalidation" m ON m.key = j.key WHERE j.key IN ('refresh:search', 'refresh:quality', 'refresh:recipes', 'refresh:conversions') ORDER BY j.key`,
        )
      ).rows,
    ).toEqual([
      {
        key: "refresh:conversions",
        observed: 1,
        revision: 1,
        restartsPass: true,
      },
      { key: "refresh:quality", observed: 1, revision: 1, restartsPass: false },
      { key: "refresh:recipes", observed: 1, revision: 1, restartsPass: true },
      { key: "refresh:search", observed: 1, revision: 1, restartsPass: true },
    ]);
    // The drain's due predicate (`generic/jobs/repo/jobs.ts`), in SQL; Job
    // timestamps are UTC without a zone.
    const due = async () =>
      (
        await client.query<{ key: string }>(
          `SELECT key FROM "Job" WHERE key IN ('refresh:search', 'refresh:quality', 'refresh:recipes', 'refresh:conversions') AND (
             (state IN ('queued', 'retry_wait') AND "availableAt" <= timezone('UTC', now()))
             OR (state = 'running' AND "leaseExpiresAt" <= timezone('UTC', now()))
             OR (state IN ('queued', 'retry_wait', 'completed') AND EXISTS (
               SELECT 1 FROM "JobInvalidation" ji WHERE ji.key = "Job".key
                 AND ji.revision > coalesce("Job"."observedRevision", 0))))
           ORDER BY key`,
        )
      ).rows.map((row) => row.key);
    // Pending passes stay due; the finished one waits; the running one keeps
    // its live lease. Nothing pending before the cutover is dropped.
    expect(await due()).toEqual(["refresh:conversions", "refresh:quality"]);
    // The first capture after the cutover (`recordJobInvalidation`) writes
    // only the marker and wakes the finished pass; the running pass now
    // trails the marker, so its publication supersedes it.
    await client.query(
      `UPDATE "JobInvalidation" SET revision = revision + 1 WHERE key IN ('refresh:search', 'refresh:recipes')`,
    );
    expect(
      (
        await client.query(
          `SELECT ${executionColumns} FROM "Job" WHERE key IN ('refresh:search', 'refresh:quality', 'refresh:recipes', 'refresh:conversions') ORDER BY key`,
        )
      ).rows,
    ).toEqual(before.rows);
    expect(await due()).toEqual([
      "refresh:conversions",
      "refresh:quality",
      "refresh:search",
    ]);
    expect(
      (
        await client.query(
          `SELECT m.revision > j."observedRevision" AS trails FROM "Job" j
           JOIN "JobInvalidation" m ON m.key = j.key WHERE j.key = 'refresh:recipes'`,
        )
      ).rows,
    ).toEqual([{ trails: true }]);
  });
});
