import { drizzle } from "drizzle-orm/node-postgres";
import { expect, it } from "vitest";

import { migrateDatabase } from "./db-migrate";
import { withMigrationDatabase } from "./test-database-lease";

// Production shapes before the cutover: exhausted Jobs stranding leased rows,
// expired leases nobody reclaimed, device-waiting rows, terminal failures and
// open rows without any Job. Every open row must reach a live Job in its lane.
it("reopens stranded image work into executor lanes without losing history", async () => {
  await withMigrationDatabase(async (client) => {
    const db = drizzle(client);
    await migrateDatabase(db, {
      through: "0027_job_invalidation",
    });
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const hash = "a".repeat(64);
    const images = [
      { n: 1, type: "image/jpeg" },
      { n: 2, type: "image/avif" },
    ];
    for (const { n, type } of images) {
      await client.query(
        `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'image', $2)`,
        [id(n), `IMG-SYN${n}`],
      );
      await client.query(
        `INSERT INTO "Image" (id, shortcode, key, filename, size, "contentType", status, sha256)
         VALUES ($1, $2, $3, 'synthetic.jpg', 100, $4, 'UPLOADED', $5)`,
        [id(n), `IMG-SYN${n}`, `synthetic/${n}`, type, hash],
      );
    }
    // [row, image, kind, revision, state, Job state | null, lease]
    const rows = [
      [11, 1, "subject_lift", 2, "leased", "failed", null],
      [12, 1, "describe_image", 7, "leased", "running", "expired"],
      [
        13,
        1,
        "describe_image",
        1985616673,
        "waiting_for_device",
        "queued",
        null,
      ],
      [14, 2, "describe_image", 7, "failed", "failed", null],
      [15, 1, "identify_image", 9, "pending", null, null],
      [16, 2, "identify_image", 9, "ready", "completed", null],
    ] as const;
    for (const [n, image, kind, revision, state, execution, lease] of rows) {
      await client.query(
        `INSERT INTO "Entity" (id, kind, shortcode) VALUES ($1, 'imageJob', $2)`,
        [id(n), `IPR-SYN${n}`],
      );
      await client.query(
        `INSERT INTO "ImageProcessingJob"
           (id, shortcode, "imageId", kind, state, "sourceContentHash", "processorRevision", "attemptId", "lastError", attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Synthetic retained error', 2)`,
        [
          id(n),
          `IPR-SYN${n}`,
          id(image),
          kind,
          state,
          hash,
          revision,
          state === "leased" ? id(n + 100) : null,
        ],
      );
      if (execution)
        await client.query(
          `INSERT INTO "Job" (key, kind, input, state, attempts, error, "leaseToken", "leaseExpiresAt", "subjectKind", "subjectId")
           VALUES ($1, 'image.processing', $2, $3, 3, 'Synthetic job error', $4, $5, 'image', $6)`,
          [
            `image-processing:${id(n)}`,
            JSON.stringify({ processingId: id(n) }),
            execution,
            lease ? id(n + 100) : null,
            lease ? new Date(Date.now() - 60_000) : null,
            id(image),
          ],
        );
    }
    await migrateDatabase(db, { through: "0028_image_job_lanes" });
    const after = await client.query<{
      id: string;
      state: string;
      attemptId: string | null;
      lastError: string | null;
      attempts: number;
      kind: string | null;
      jobState: string | null;
      jobError: string | null;
      leaseToken: string | null;
    }>(
      `SELECT j.id, j.state, j."attemptId", j."lastError", j.attempts,
         dj.kind, dj.state AS "jobState", dj.error AS "jobError", dj."leaseToken"
       FROM "ImageProcessingJob" j
       LEFT JOIN "Job" dj ON dj.key = 'image-processing:' || j.id::text
       ORDER BY j.id`,
    );
    const byId = Object.fromEntries(after.rows.map((row) => [row.id, row]));
    // Exhausted Job, stranded leased row: reopened in the device lane.
    expect(byId[id(11)]).toMatchObject({
      state: "pending",
      attemptId: id(111),
      lastError: "Synthetic retained error",
      attempts: 2,
      kind: "image.device",
      jobState: "queued",
      jobError: "Synthetic job error",
    });
    // Expired lease: still claimable by its lane, its token kept for adoption.
    expect(byId[id(12)]).toMatchObject({
      state: "pending",
      kind: "image.cloud",
      jobState: "running",
      leaseToken: id(112),
    });
    expect(byId[id(13)]).toMatchObject({
      state: "pending",
      kind: "image.device",
      jobState: "queued",
    });
    // A terminal failure with a live source reopens; AVIF input runs on a device.
    expect(byId[id(14)]).toMatchObject({
      state: "pending",
      kind: "image.device",
      jobState: "queued",
    });
    // An open row without any Job gets one in its lane.
    expect(byId[id(15)]).toMatchObject({
      state: "pending",
      kind: "image.cloud",
      jobState: "queued",
    });
    // Settled work keeps its outcome and finished Job.
    expect(byId[id(16)]).toMatchObject({
      state: "ready",
      kind: "image.cloud",
      jobState: "completed",
    });
    await client.query(
      `INSERT INTO "ImageProcessingAttempt" (id, "jobId", number, state) VALUES ($1, $2, 1, 'released')`,
      [id(200), id(11)],
    );
    expect(
      (
        await client.query(
          `SELECT count(*)::int AS n FROM "Job" WHERE kind = 'image.processing'`,
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  });
});
