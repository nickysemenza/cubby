import { drizzle } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

const APPLE_DESCRIPTION_REVISION = 1985616673;

const identity = (
  client: Client,
  kind: string,
  id: string,
  shortcode: string,
) =>
  client.query(
    `INSERT INTO "Entity" (id, shortcode, kind) VALUES ($1, $2, $3)`,
    [id, shortcode, kind],
  );

it("moves open image execution onto ImageProcessingJob with backoff, failures and live leases intact", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0072_assessment_read_publications" });
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const imageId = id(1);
    await identity(client, "image", imageId, "IMG-SYNTH1");
    await client.query(
      `INSERT INTO "Image" (id, shortcode, key, filename, "contentType", size, status, sha256)
       VALUES ($1, 'IMG-SYNTH1', 'synthetic/key', 'synthetic.jpg', 'image/jpeg', 1, 'UPLOADED', $2)`,
      [imageId, "a".repeat(64)],
    );
    const seed = async (
      n: number,
      kind: string,
      revision: number,
      state: string,
      attemptId: string | null,
    ) => {
      await identity(client, "imageJob", id(n), `IPR-SYNTH${n}`);
      await client.query(
        `INSERT INTO "ImageProcessingJob" (id, shortcode, "imageId", kind, state, "processorRevision", "sourceContentHash", "attemptId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id(n),
          `IPR-SYNTH${n}`,
          imageId,
          kind,
          state,
          revision,
          "a".repeat(64),
          attemptId,
        ],
      );
    };
    const job = async (
      n: number,
      kind: string,
      state: string,
      fields: {
        attempts?: number;
        availableAt?: string;
        leaseToken?: string;
        leaseExpiresAt?: string;
        waitReason?: string;
      } = {},
    ) => {
      await identity(client, "job", id(n + 100), `JOB-SYNTH${n}`);
      await client.query(
        `INSERT INTO "Job" (id, shortcode, key, kind, state, input, attempts, "availableAt", "leaseToken", "leaseExpiresAt", "waitReason")
         VALUES ($1, $2, $3, $4, $5, '{}', $6, $7, $8, $9, $10)`,
        [
          id(n + 100),
          `JOB-SYNTH${n}`,
          `image-processing:${id(n)}`,
          kind,
          state,
          fields.attempts ?? 0,
          fields.availableAt ?? "2026-01-01T00:00:00Z",
          fields.leaseToken ?? null,
          fields.leaseExpiresAt ?? null,
          fields.waitReason ?? null,
        ],
      );
    };
    const backoff = "2026-03-01T00:00:00.000Z";
    const lease = "2026-03-02T00:00:00.000Z";
    const attempt = id(50);
    await seed(
      2,
      "describe_image",
      APPLE_DESCRIPTION_REVISION,
      "pending",
      null,
    );
    await job(2, "image.device", "retry_wait", {
      attempts: 7,
      availableAt: backoff,
    });
    await seed(3, "subject_lift", 2, "pending", attempt);
    await job(3, "image.device", "running", {
      leaseToken: attempt,
      leaseExpiresAt: lease,
    });
    await seed(4, "identify_image", 7, "pending", null);
    await job(4, "image.cloud", "queued", {
      availableAt: backoff,
      waitReason: "ai_funding_window",
    });
    await seed(5, "describe_image", 8, "ready", null);
    await job(5, "image.cloud", "completed");
    await identity(client, "job", id(200), "JOB-SYNTHW");
    await client.query(
      `INSERT INTO "Job" (id, shortcode, key, kind, state, input) VALUES ($1, 'JOB-SYNTHW', 'image.device.wake', 'image.device.wake', 'queued', '{}')`,
      [id(200)],
    );
    await client.query(
      `INSERT INTO "JobInvalidationCapture" (key, "capturedAt") VALUES ('image.device.wake', now())`,
    );
    const before = (
      await client.query(
        `SELECT id, state, attempts, result, "attemptId" FROM "ImageProcessingJob" ORDER BY id`,
      )
    ).rows;

    await migrateDatabase(db, { through: "0073_image_jobs_own_execution" });

    const rows = (
      await client.query(
        `SELECT id, lane, failures, "waitReason", "attemptId",
           to_char("runAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "runAt",
           to_char("leaseUntil", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "leaseUntil"
         FROM "ImageProcessingJob" ORDER BY id`,
      )
    ).rows;
    expect(rows[0]).toMatchObject({
      lane: "device",
      failures: 7,
      runAt: backoff,
      leaseUntil: null,
    });
    expect(rows[1]).toMatchObject({
      lane: "device",
      failures: 0,
      leaseUntil: lease,
      attemptId: attempt,
    });
    expect(rows[2]).toMatchObject({
      lane: "cloud",
      runAt: backoff,
      waitReason: "ai_funding_window",
    });
    expect(rows[3]).toMatchObject({ lane: "cloud", failures: 0 });
    // Domain outcomes and attempt counts are untouched.
    expect(
      (
        await client.query(
          `SELECT id, state, attempts, result, "attemptId" FROM "ImageProcessingJob" ORDER BY id`,
        )
      ).rows,
    ).toEqual(before);
    // No receipts remain, and no predecessor writer can recreate a retired kind.
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS left FROM "Job" WHERE kind IN ('image.cloud', 'image.device', 'image.device.wake')`,
        )
      ).rows,
    ).toEqual([{ left: 0 }]);
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS left FROM "Entity" WHERE id = ANY($1::uuid[])`,
          [[id(102), id(103), id(104), id(105), id(200)]],
        )
      ).rows,
    ).toEqual([{ left: 0 }]);
    await expect(
      client.query(
        `INSERT INTO "Job" (shortcode, key, kind, input) VALUES ('JOB-LATE', 'late', 'image.cloud', '{}')`,
      ),
    ).rejects.toThrow("Job_kind_retired_check");
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS open FROM "JobInvalidationCapture" WHERE key = 'image.device.wake' AND NOT observed`,
        )
      ).rows,
    ).toEqual([{ open: 0 }]);
  });
});

it("refuses the cutover while a member's pause holds open image work", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0072_assessment_read_publications" });
    const imageId = "00000000-0000-4000-8000-000000000001";
    const jobId = "00000000-0000-4000-8000-000000000002";
    const executionId = "00000000-0000-4000-8000-000000000003";
    await identity(client, "image", imageId, "IMG-SYNTH1");
    await identity(client, "imageJob", jobId, "IPR-SYNTH1");
    await identity(client, "job", executionId, "JOB-SYNTH1");
    await client.query(
      `INSERT INTO "Image" (id, shortcode, key, filename, "contentType", size, status)
       VALUES ($1, 'IMG-SYNTH1', 'synthetic/key', 'synthetic.jpg', 'image/jpeg', 1, 'UPLOADED')`,
      [imageId],
    );
    await client.query(
      `INSERT INTO "ImageProcessingJob" (id, shortcode, "imageId", kind, state, "processorRevision", "sourceContentHash")
       VALUES ($1, 'IPR-SYNTH1', $2, 'subject_lift', 'pending', 2, 'hash')`,
      [jobId, imageId],
    );
    await client.query(
      `INSERT INTO "Job" (id, shortcode, key, kind, state, input)
       VALUES ($1, 'JOB-SYNTH1', $2, 'image.device', 'paused', '{}')`,
      [executionId, `image-processing:${jobId}`],
    );
    await expect(
      migrateDatabase(db, { through: "0073_image_jobs_own_execution" }),
    ).rejects.toThrow("paused image Job");
  });
});

// Live writers take these two tables in both orders. A cutover that held one and
// waited for the other could deadlock on every attempt, as 0037 did.
it.each([
  [
    "Job first",
    `UPDATE "Job" SET attempts = attempts WHERE kind = 'image.cloud'`,
    `UPDATE "ImageProcessingJob" SET attempts = attempts`,
  ],
  [
    "image row first",
    `UPDATE "ImageProcessingJob" SET attempts = attempts`,
    `UPDATE "Job" SET attempts = attempts WHERE kind = 'image.cloud'`,
  ],
])(
  "survives a live writer crossing its locks (%s)",
  async (_order, first, second) => {
    await withMigrationDatabase(async (client, databaseUrl) => {
      const db = drizzle(client);
      await migrateDatabase(db, {
        through: "0072_assessment_read_publications",
      });
      const id = (n: number) =>
        `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      await identity(client, "image", id(1), "IMG-SYNTH1");
      await client.query(
        `INSERT INTO "Image" (id, shortcode, key, filename, "contentType", size, status)
       VALUES ($1, 'IMG-SYNTH1', 'synthetic/key', 'synthetic.jpg', 'image/jpeg', 1, 'UPLOADED')`,
        [id(1)],
      );
      await identity(client, "imageJob", id(2), "IPR-SYNTH1");
      await client.query(
        `INSERT INTO "ImageProcessingJob" (id, shortcode, "imageId", kind, state, "processorRevision", "sourceContentHash")
       VALUES ($1, 'IPR-SYNTH1', $2, 'identify_image', 'pending', 7, 'hash')`,
        [id(2), id(1)],
      );
      await identity(client, "job", id(3), "JOB-SYNTH1");
      await client.query(
        `INSERT INTO "Job" (id, shortcode, key, kind, state, input, attempts)
       VALUES ($1, 'JOB-SYNTH1', $2, 'image.cloud', 'retry_wait', '{}', 3)`,
        [id(3), `image-processing:${id(2)}`],
      );
      const writer = new Client({ connectionString: databaseUrl });
      await writer.connect();
      try {
        await writer.query("BEGIN");
        await writer.query(first);
        const migrating = migrateDatabase(db, {
          through: "0073_image_jobs_own_execution",
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        // Whichever side Postgres aborts, the writer's own transaction ends and the
        // migration's rolled-back statement is taken again whole.
        await writer.query(second).catch(() => undefined);
        await writer.query("COMMIT").catch(() => undefined);
        await migrating;
      } finally {
        await writer.end();
      }
      expect(
        (
          await client.query(
            `SELECT lane, failures FROM "ImageProcessingJob" WHERE id = $1`,
            [id(2)],
          )
        ).rows,
      ).toEqual([{ lane: "cloud", failures: 3 }]);
    });
  },
  60_000,
);
