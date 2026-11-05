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

it("carries an owed embedding from its WorkItem onto its SearchDocument", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0076_drop_dead_columns" });
    const productId = "00000000-0000-4000-8000-000000000001";
    await identity(client, "product", productId, "PRD-SYNTH1");
    await client.query(
      `INSERT INTO "Product" (id, shortcode, name) VALUES ($1, 'PRD-SYNTH1', 'Synthetic')`,
      [productId],
    );
    await client.query(
      `INSERT INTO "SearchDocument" ("entityKind", "entityId", title, body, "semanticText", "normalizedText", "searchVector", "sourceHash")
       VALUES ('product', $1, 'Synthetic', 'b', 's', 'n', ''::tsvector, 'h')`,
      [productId],
    );
    await client.query(
      `INSERT INTO "WorkItem" (drain, target, ref, attempts, "lastError", "readyAt")
       VALUES ('embedding:refresh', 'embedding.refresh', $1, 2, 'Synthetic outage', '2026-03-01T00:00:00Z')`,
      [productId],
    );
    await client.query(
      `INSERT INTO "WorkItem" (drain, target, ref) VALUES ('derived:drain', 'synthetic.target', $1)`,
      [productId],
    );
    await identity(
      client,
      "job",
      "00000000-0000-4000-8000-000000000002",
      "JOB-SYNTH1",
    );
    await client.query(
      `INSERT INTO "Job" (id, shortcode, key, kind, state, input)
       VALUES ('00000000-0000-4000-8000-000000000002', 'JOB-SYNTH1', 'embedding:refresh', 'embedding.refresh', 'running', '{}')`,
    );

    await migrateDatabase(db, { through: "0077_embedding_work_on_owner_rows" });

    expect(
      (
        await client.query(
          `SELECT to_char("embeddingDueAt", 'YYYY-MM-DD') AS due, "embeddingAttempts" AS attempts, "embeddingError" AS error FROM "SearchDocument"`,
        )
      ).rows,
    ).toEqual([{ due: "2026-03-01", attempts: 2, error: "Synthetic outage" }]);
    // The running predecessor may be paying right now, and deleting its Job cannot stop
    // that call, so its items stay reserved past the longest a consumer can run.
    expect(
      (
        await client.query(
          `SELECT "embeddingLeaseToken" IS NOT NULL AS reserved,
             "embeddingLeaseUntil" > now() + interval '15 minutes' AS outlasts FROM "SearchDocument"`,
        )
      ).rows,
    ).toEqual([{ reserved: true, outlasts: true }]);
    // Derived work is another lane's: it stays exactly where it was.
    expect(
      (
        await client.query(
          `SELECT drain FROM "WorkItem" WHERE target = 'synthetic.target'`,
        )
      ).rows,
    ).toEqual([{ drain: "derived:drain" }]);
    expect(
      (
        await client.query(
          `SELECT 1 FROM "Job" WHERE key = 'embedding:refresh'`,
        )
      ).rows,
    ).toEqual([]);
    // A predecessor's late mark or wake fails rather than stranding its intent.
    await expect(
      client.query(
        `INSERT INTO "WorkItem" (drain, target, ref) VALUES ('embedding:refresh', 'embedding.refresh', $1)`,
        [productId],
      ),
    ).rejects.toThrow("WorkItem_retired_target_check");
    await expect(
      client.query(
        `INSERT INTO "Job" (shortcode, key, kind, input) VALUES ('JOB-LATE', 'embedding:refresh', 'embedding.refresh', '{}')`,
      ),
    ).rejects.toThrow("Job_kind_retired_check");
  });
});

it("moves owed AI evaluations onto their rows and keeps paid results and parked work", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0077_embedding_work_on_owner_rows" });
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    await client.query(`INSERT INTO "user" (id, name, email)
      VALUES ('synthetic-user', 'Synthetic', 'synthetic@example.test')`);
    await identity(client, "run", id(1), "RUN-SYNTH1");
    await client.query(
      `INSERT INTO "Run" (id, shortcode, purpose, trigger, "actorUserId", "actorName", "actorEmail")
       VALUES ($1, 'RUN-SYNTH1', 'maintenance', 'manual', 'synthetic-user', 'Synthetic', 'synthetic@example.test')`,
      [id(1)],
    );
    const evaluation = (n: number, state: string, result: unknown = null) =>
      client.query(
        `INSERT INTO "AiEvaluation" (id, "runId", "workKey", feature, target, provenance, snapshot, state, result)
         VALUES ($1::uuid, $2, $3, 'synthetic-feature',
           jsonb_build_object('entity', 'product', 'recordId', $1::text), '{}', '{}', $4, $5::jsonb)`,
        [id(n), id(1), `synthetic-work-${n}`, state, JSON.stringify(result)],
      );
    await evaluation(2, "queued");
    await evaluation(3, "result_ready", { paid: "Synthetic answer" });
    await evaluation(4, "queued");
    await evaluation(5, "completed", { paid: "Synthetic answer" });
    const item = (n: number, attempts: number, priority: number) =>
      client.query(
        `INSERT INTO "WorkItem" (drain, target, ref, attempts, priority, "readyAt", "lastError", "waitCause", "waitStartedAt")
         VALUES ('ai-evaluation:synthetic-feature', 'ai.evaluation', $1, $2, $3, '2026-03-01T00:00:00Z', 'Synthetic retry', 'search_coverage', now())`,
        [id(n), attempts, priority],
      );
    await item(2, 2, 0);
    await item(3, 1, 1);
    await item(5, 0, 1);
    await identity(client, "job", id(6), "JOB-SYNTH1");
    await client.query(
      `INSERT INTO "Job" (id, shortcode, key, kind, state, input)
       VALUES ($1, 'JOB-SYNTH1', 'ai-evaluation:synthetic-feature', 'ai.evaluation', 'running', '{}')`,
      [id(6)],
    );
    const paid = async () =>
      (
        await client.query(
          `SELECT id, state, result, snapshot, provenance FROM "AiEvaluation" ORDER BY id`,
        )
      ).rows;
    const before = await paid();

    await migrateDatabase(db, {
      through: "0078_ai_evaluations_own_their_work",
    });

    expect(await paid()).toEqual(before);
    const rows = (
      await client.query(
        `SELECT to_char("runAt", 'YYYY-MM-DD') AS "runAt", priority, attempts, "waitCause", error FROM "AiEvaluation" ORDER BY id`,
      )
    ).rows;
    const owed = {
      runAt: "2026-03-01",
      waitCause: "search_coverage",
      error: "Synthetic retry",
    };
    expect(rows[0]).toEqual({ ...owed, priority: 0, attempts: 2 });
    expect(rows[1]).toEqual({ ...owed, priority: 1, attempts: 1 });
    // The running predecessor may be paying right now, and deleting its Job cannot stop
    // that call, so its rows stay reserved past the longest a consumer can run.
    expect(
      (
        await client.query(
          `SELECT "leaseToken" IS NOT NULL AS reserved, "leaseUntil" > now() + interval '15 minutes' AS outlasts
           FROM "AiEvaluation" WHERE "runAt" IS NOT NULL`,
        )
      ).rows,
    ).toEqual([
      { reserved: true, outlasts: true },
      { reserved: true, outlasts: true },
    ]);
    // Parked stays parked, and a settled evaluation owes nothing.
    expect(rows[2]).toMatchObject({ runAt: null, attempts: 0 });
    expect(rows[3]).toMatchObject({ runAt: null, attempts: 0 });
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS left FROM "WorkItem" WHERE target = 'ai.evaluation'`,
        )
      ).rows,
    ).toEqual([{ left: 0 }]);
  });
});

it("retires the Job entity without deleting a row, and new Jobs need no identity", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0085_automatic_ai_evaluations_have_no_run",
    });
    const id = "00000000-0000-4000-8000-000000000001";
    await identity(client, "job", id, "JOB-SYNTH1");
    await client.query(
      `INSERT INTO "Job" (id, shortcode, key, kind, state, input, attempts)
       VALUES ($1, 'JOB-SYNTH1', 'synthetic:paused', 'run.execute', 'paused', '{}', 2)`,
      [id],
    );

    await migrateDatabase(db, { through: "0088_job_is_no_longer_an_entity" });

    expect(
      (
        await client.query(`SELECT state, attempts FROM "Job" WHERE id = $1`, [
          id,
        ])
      ).rows,
    ).toEqual([{ state: "paused", attempts: 2 }]);
    expect(
      (await client.query(`SELECT kind FROM "Entity" WHERE id = $1`, [id]))
        .rows,
    ).toEqual([{ kind: "job" }]);
    await client.query(
      `INSERT INTO "Job" (key, kind, input) VALUES ('synthetic:fresh', 'synthetic', '{}')`,
    );
    await expect(
      identity(
        client,
        "job",
        "00000000-0000-4000-8000-000000000002",
        "JOB-SYNTH2",
      ),
    ).rejects.toThrow("Entity_kind_check");
  });
});

it("deletes old Job identities and leaves unfinished Jobs and their attempts", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0085_automatic_ai_evaluations_have_no_run",
    });
    const id = "00000000-0000-4000-8000-000000000001";
    await identity(client, "job", id, "JOB-SYNTH1");
    await client.query(
      `INSERT INTO "Job" (id, shortcode, key, kind, state, input, attempts)
       VALUES ($1, 'JOB-SYNTH1', 'synthetic:paused', 'run.execute', 'paused', '{}', 2)`,
      [id],
    );
    await migrateDatabase(db, {
      through: "0091_drop_columns_that_hold_nothing",
    });
    await client.query(
      `INSERT INTO "JobLaneAdmission" (lane, "ownedStreak") VALUES ('synthetic', 1)`,
    );

    await migrateDatabase(db, { through: "0092_drop_job_identities" });

    expect(
      (
        await client.query(`SELECT state, attempts FROM "Job" WHERE id = $1`, [
          id,
        ])
      ).rows,
    ).toEqual([{ state: "paused", attempts: 2 }]);
    expect(
      (await client.query(`SELECT 1 FROM "Entity" WHERE kind = 'job'`)).rows,
    ).toEqual([]);
    expect(
      (
        await client.query(`SELECT convalidated FROM pg_constraint
          WHERE conname IN ('Entity_kind_check', 'Entity_shortcode_prefix_check')`)
      ).rows,
    ).toEqual([{ convalidated: true }, { convalidated: true }]);
    await expect(
      client.query(`SELECT 1 FROM "JobLaneAdmission"`),
    ).rejects.toThrow("does not exist");
  });
});

it("refuses to retire an unfinished Job of a retired kind", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0092_drop_job_identities" });
    await client.query(
      `INSERT INTO "Job" (key, kind, state, input, attempts) VALUES
       ('synthetic:done', 'ai-refresh.activate', 'completed', '{}', 1),
       ('synthetic:held', 'ai-refresh.activate', 'paused', '{}', 2)`,
    );

    await expect(
      migrateDatabase(db, { through: "0093_retire_two_job_kinds" }),
    ).rejects.toThrow("Failed query");

    expect(
      (
        await client.query(
          `SELECT key, state, attempts FROM "Job" WHERE key = 'synthetic:held'`,
        )
      ).rows,
    ).toEqual([{ key: "synthetic:held", state: "paused", attempts: 2 }]);
  });
});

it("retires two Job kinds and leaves paused work", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0092_drop_job_identities" });
    await client.query(
      `INSERT INTO "Job" (key, kind, state, input, attempts) VALUES
       ('synthetic:correction', 'assessment.correction', 'completed', '{}', 1),
       ('synthetic:activate', 'ai-refresh.activate', 'completed', '{}', 1),
       ('synthetic:paused', 'run.execute', 'paused', '{}', 2)`,
    );

    await migrateDatabase(db, { through: "0093_retire_two_job_kinds" });

    expect(
      (
        await client.query(
          `SELECT key, state, attempts FROM "Job" ORDER BY key`,
        )
      ).rows,
    ).toContainEqual({ key: "synthetic:paused", state: "paused", attempts: 2 });
    expect(
      (
        await client.query(
          `SELECT 1 FROM "Job" WHERE kind IN ('assessment.correction', 'ai-refresh.activate')`,
        )
      ).rows,
    ).toEqual([]);
    await expect(
      client.query(
        `INSERT INTO "Job" (key, kind, input) VALUES ('synthetic:late', 'ai-refresh.activate', '{}')`,
      ),
    ).rejects.toThrow("Job_kind_retired_check");
  });
});

it("drops Job's unread columns and keeps paused work and its attempts", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, { through: "0093_retire_two_job_kinds" });
    await client.query(
      `INSERT INTO "Job" (key, kind, state, input, attempts, "subjectKind", "subjectId")
       VALUES ('synthetic:paused', 'run.execute', 'paused', '{}', 2, 'image', 'synthetic')`,
    );

    await migrateDatabase(db, { through: "0094_drop_unread_job_columns" });

    expect(
      (
        await client.query(
          `SELECT state, attempts FROM "Job" WHERE key = 'synthetic:paused'`,
        )
      ).rows,
    ).toEqual([{ state: "paused", attempts: 2 }]);
  });
});
