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
