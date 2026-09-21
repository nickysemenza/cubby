import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { expect, it } from "vitest";

import { withTransaction } from "./database-helpers";
const ctx = withTestDb();
it("expands populated legacy jobs without inventing historical attempts and is replayable", async () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      "../../scripts/cutovers/activity-history.expand.sql",
    ),
    "utf8",
  ).replace(/^BEGIN;|^COMMIT;/gm, "");
  await withTransaction(ctx.db, async (tx) => {
    await tx.execute(
      sql.raw(`CREATE SCHEMA activity_migration_contract; SET LOCAL search_path TO activity_migration_contract;
   CREATE TABLE "ImageProcessingJob" (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), state text NOT NULL);
   CREATE TABLE "ImportRunOperation" (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
   INSERT INTO "ImageProcessingJob" (state) VALUES ('ready'),('failed');`),
    );
    await tx.execute(sql.raw(migration));
    await tx.execute(sql.raw(migration));
    const jobs = await tx.execute(
      sql`SELECT "publicId", "submissionId", state FROM "ImageProcessingJob" ORDER BY state`,
    );
    expect(jobs.rows).toHaveLength(2);
    expect(jobs.rows).toEqual([
      expect.objectContaining({
        publicId: expect.stringMatching(/^IPR-/),
        submissionId: null,
        state: "failed",
      }),
      expect.objectContaining({
        publicId: expect.stringMatching(/^IPR-/),
        submissionId: null,
        state: "ready",
      }),
    ]);
    const history = await tx.execute(
      sql`SELECT count(*)::int AS count FROM "ImageProcessingAttempt"`,
    );
    expect(history.rows).toEqual([{ count: 0 }]);
  });
});
