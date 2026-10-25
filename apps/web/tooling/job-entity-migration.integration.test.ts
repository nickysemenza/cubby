import { readFileSync } from "node:fs";
import { createDatabase } from "~/server/db/database-runtime";
import * as schema from "~/server/db/schema";
import { pruneOrphanJobIdentities } from "~/server/generic/jobs/repo/queue-health";
import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";
import { MIGRATIONS_FOLDER, migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("backfills multiple Job batches without changing execution or retained captures and replays safely", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0035_music_category_family" });
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
}, 30_000);

it("reconciles identities orphaned by old retention between committed backfill batches", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    const runtimeClient = drizzle({ client, schema });
    await migrateDatabase(db, { through: "0035_music_category_family" });
    await client.query(
      `INSERT INTO "Job" (key,kind,input) SELECT 'synthetic:cutover:' || n, 'synthetic.cutover', '{}'::jsonb FROM generate_series(1,1002) n`,
    );
    const statements = readFileSync(
      `${MIGRATIONS_FOLDER}/0036_job_entity_identity.sql`,
      "utf8",
    ).split("--> statement-breakpoint");
    for (const statement of statements) {
      await client.query(statement);
      if (statement.includes("-- cubby:repeat-batch")) break;
    }
    // The first batch committed; the old Worker deletes payloads without knowing Entity.
    await client.query(
      `DELETE FROM "Job" WHERE id IN (SELECT id FROM "Job" WHERE shortcode IS NOT NULL AND key LIKE 'synthetic:cutover:%' LIMIT 2)`,
    );
    await migrateDatabase(db, { through: "0036_job_entity_identity" });
    await client.query(
      `INSERT INTO "Entity" (id, kind, shortcode) VALUES (gen_random_uuid(), 'image', 'IMG-23456')`,
    );
    const handle = createDatabase(() => ({
      client: runtimeClient,
      withConnection: (fn) => fn(runtimeClient),
    }));
    expect(await pruneOrphanJobIdentities(handle, { limit: 1 })).toBe(1);
    expect(await pruneOrphanJobIdentities(handle, { limit: 1 })).toBe(1);
    expect(await pruneOrphanJobIdentities(handle, { limit: 1 })).toBe(0);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM "Job" j JOIN "Entity" e ON e.id = j.id AND e.shortcode = j.shortcode WHERE j.key LIKE 'synthetic:cutover:%'`,
        )
      ).rows,
    ).toEqual([{ n: 1000 }]);
    expect(
      (
        await client.query(
          `SELECT shortcode FROM "Entity" WHERE kind = 'image'`,
        )
      ).rows,
    ).toEqual([{ shortcode: "IMG-23456" }]);
  });
}, 30_000);
