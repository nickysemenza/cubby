import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("backfills multiple Job batches without changing execution or retained captures and replays safely", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0034_append_only_job_invalidation" });
    await client.query(`INSERT INTO "Job" (key,kind,input,state,attempts,error,"availableAt","createdAt","updatedAt")
      SELECT 'synthetic:identity:' || n, 'synthetic.migration', jsonb_build_object('page',n),
        CASE WHEN n % 3 = 0 THEN 'paused' WHEN n % 3 = 1 THEN 'retry_wait' ELSE 'completed' END,
        2, 'Synthetic retained error', '2026-01-01', '2025-12-01', '2026-01-01'
      FROM generate_series(1,1001) n`);
    await client.query(`INSERT INTO "JobInvalidationCapture" (key,"capturedAt",observed)
      VALUES ('synthetic:identity:1','2026-01-01',false), ('synthetic:identity:2','2026-01-01',true)`);
    const executions = async () =>
      (
        await client.query(
          `SELECT id, md5((to_jsonb(j)-'shortcode')::text) AS digest FROM "Job" j ORDER BY id`,
        )
      ).rows;
    const captures = async () =>
      (await client.query(`SELECT * FROM "JobInvalidationCapture" ORDER BY id`))
        .rows;
    const before = await executions();
    const retained = await captures();
    await migrateDatabase(db, { through: "0036_job_entity_identity" });
    expect(await executions()).toEqual(before);
    expect(await captures()).toEqual(retained);
    const identity = async () =>
      (
        await client.query(`SELECT j.id, j.shortcode,
      e.kind, e.shortcode AS canonical, e."createdAt" = j."createdAt" AS dated
      FROM "Job" j JOIN "Entity" e ON e.id = j.id ORDER BY j.id`)
      ).rows;
    const first = await identity();
    expect(first).toHaveLength(before.length);
    for (const row of first) {
      expect(row.shortcode).toMatch(
        /^JOB-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/,
      );
      expect(row.canonical).toBe(row.shortcode);
      expect(row.kind).toBe("job");
      expect(row.dated).toBe(true);
    }
    // Emulate a crash after committed batches but before the journal receipt.
    await client.query(`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (
      SELECT max(created_at) FROM drizzle.__drizzle_migrations)`);
    await migrateDatabase(db, { through: "0036_job_entity_identity" });
    expect(await identity()).toEqual(first);
    expect(await executions()).toEqual(before);
  });
});
