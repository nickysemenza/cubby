import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

it("carries every pending capture and execution through append-only invalidation cutover", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0033_refresh_family_policy" });
    const cases = [
      {
        key: "observed",
        state: "completed",
        observed: 3,
        revision: 3,
        captures: [1, 3],
      },
      {
        key: "pending",
        state: "completed",
        observed: 3,
        revision: 5,
        captures: [3, 4, 5],
      },
      {
        key: "missing-log",
        state: "completed",
        observed: 2,
        revision: 4,
        captures: [],
      },
      {
        key: "running",
        state: "running",
        observed: 8,
        revision: 9,
        captures: [8, 9],
      },
      {
        key: "queued",
        state: "queued",
        observed: 1,
        revision: 2,
        captures: [2],
      },
      {
        key: "retry",
        state: "retry_wait",
        observed: 3,
        revision: 4,
        captures: [4],
      },
      {
        key: "paused",
        state: "paused",
        observed: 4,
        revision: 5,
        captures: [5],
      },
      {
        key: "cancelled",
        state: "cancelled",
        observed: null,
        revision: 5,
        captures: [5],
      },
      {
        key: "failed",
        state: "failed",
        observed: 1,
        revision: 2,
        captures: [2],
      },
    ];
    const expected = [];
    for (const seed of cases) {
      const key = `synthetic:${seed.key}`;
      await client.query(
        `INSERT INTO "Job" (key,kind,input,state,generation,attempts,"maxAttempts",cursor,result,error,"availableAt","leaseToken","leaseExpiresAt","observedRevision")
        VALUES ($1,'synthetic.migration','{}',$2,7,2,3,'{"at":"synthetic"}','{"saved":true}','Synthetic retained error','2026-06-02T00:00:00',
          CASE WHEN $2='running' THEN '00000000-0000-4000-8000-000000000071'::uuid ELSE NULL END,
          CASE WHEN $2='running' THEN '2026-06-03T00:00:00'::timestamp ELSE NULL END,$3)`,
        [key, seed.state, seed.observed],
      );
      await client.query(
        `INSERT INTO "JobInvalidation" (key,revision,"restartsPass","updatedAt") VALUES ($1,$2,true,'2026-06-01T00:00:00')`,
        [key, seed.revision],
      );
      for (const revision of seed.captures) {
        await client.query(
          `INSERT INTO "JobInvalidationCapture" (key,revision,"capturedAt") VALUES ($1,$2::bigint,'2026-05-31T00:00:00'::timestamp + $2::bigint * interval '1 second')`,
          [key, revision],
        );
        expected.push({
          key,
          observed: revision <= (seed.observed ?? 0),
          time: `2026-05-31 00:00:${String(revision).padStart(2, "0")}`,
        });
      }
      if (seed.key === "missing-log")
        expected.push({ key, observed: false, time: "2026-06-01 00:00:00" });
    }
    const executions = async () =>
      (
        await client.query(
          `SELECT key, md5((to_jsonb(j)-'observedRevision')::text) AS digest FROM "Job" j WHERE key LIKE 'synthetic:%' ORDER BY key`,
        )
      ).rows;
    const before = await executions();
    await migrateDatabase(db, { through: "0034_append_only_job_invalidation" });
    expect(await executions()).toEqual(before);
    const rows = (
      await client.query<{
        id: string;
        key: string;
        observed: boolean;
        time: string;
      }>(
        `SELECT id,key,observed,"capturedAt"::text AS time FROM "JobInvalidationCapture" WHERE key LIKE 'synthetic:%' ORDER BY key,"capturedAt"`,
      )
    ).rows;
    expect(new Set(rows.map((row) => row.id)).size).toBe(expected.length);
    expect(
      rows.map((row) => ({
        key: row.key,
        observed: row.observed,
        time: row.time,
      })),
    ).toEqual(
      [...expected].sort(
        (a, b) => a.key.localeCompare(b.key) || a.time.localeCompare(b.time),
      ),
    );
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS count FROM "JobInvalidation" WHERE key LIKE 'synthetic:%' AND "restartsPass"`,
        )
      ).rows,
    ).toEqual([{ count: cases.length }]);
    // The predecessor may fail after cutover, but its earlier source save
    // cannot commit without its now-rejected revision capture.
    await client.query("CREATE TEMP TABLE synthetic_source_save (value text)");
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO synthetic_source_save VALUES ('synthetic source evidence')",
    );
    await expect(
      client.query(
        `UPDATE "JobInvalidation" SET revision=revision+1 WHERE key='synthetic:pending'`,
      ),
    ).rejects.toMatchObject({ code: "42703" });
    await client.query("ROLLBACK");
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM synthetic_source_save",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });
});

it("refuses orphan invalidation policy without losing predecessor work", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0033_refresh_family_policy" });
    await client.query(
      `INSERT INTO "JobInvalidation" (key,revision,"restartsPass") VALUES ('synthetic:orphan',4,true)`,
    );
    await expect(
      migrateDatabase(db, { through: "0034_append_only_job_invalidation" }),
    ).rejects.toMatchObject({
      cause: {
        code: "P0001",
        message:
          "Invalidation policy without owning Job; preserve and investigate before cutover",
      },
    });
    expect(
      (
        await client.query(
          `SELECT key,revision::int AS revision FROM "JobInvalidation" WHERE key='synthetic:orphan'`,
        )
      ).rows,
    ).toEqual([{ key: "synthetic:orphan", revision: 4 }]);
    expect(
      (
        await client.query(
          `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='JobInvalidationCapture' AND column_name='observed'`,
        )
      ).rows,
    ).toEqual([]);
  });
});
