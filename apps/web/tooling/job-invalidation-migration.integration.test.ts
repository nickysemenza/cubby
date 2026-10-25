import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Existing family Jobs must start observed, so the first capture after the
// cutover writes only the marker row, and their execution facts stay intact.
it("starts existing refresh families observed and keeps their execution rows", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0026_account_cardholder_inheritance",
    });
    for (const [family, state, generation] of [
      ["search", "completed", 4],
      ["quality", "queued", 7],
    ] as const)
      await client.query(
        `INSERT INTO "Job" (key, kind, input, state, generation, cursor)
         VALUES ($1, 'refresh.family', $2, $3, $4, $5)`,
        [
          `refresh:${family}`,
          JSON.stringify({ family }),
          state,
          generation,
          family === "quality" ? JSON.stringify({ at: "synthetic" }) : null,
        ],
      );
    const before = await client.query(
      `SELECT key, state, generation, cursor FROM "Job" ORDER BY key`,
    );
    await migrateDatabase(db, { through: "0027_job_invalidation" });
    expect(
      (
        await client.query(
          `SELECT key, state, generation, cursor FROM "Job" ORDER BY key`,
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (
        await client.query(
          `SELECT j.key, j."observedRevision"::int AS observed, m.revision::int AS revision, m."restartsPass"
           FROM "Job" j JOIN "JobInvalidation" m ON m.key = j.key ORDER BY j.key`,
        )
      ).rows,
    ).toEqual([
      { key: "refresh:quality", observed: 1, revision: 1, restartsPass: false },
      { key: "refresh:search", observed: 1, revision: 1, restartsPass: true },
    ]);
  });
});
