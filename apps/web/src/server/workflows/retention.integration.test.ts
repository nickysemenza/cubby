import { parseEntityId } from "@cubby/schemas/identifiers";
import { and, count, eq, inArray, like, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  image,
  imageProcessingEvent,
  imageProcessingJob,
} from "~/server/db/schema";
import { createTransparentDerivativeAndJob } from "~/server/domains/image-processing/repo/image-processing";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";

const runRetention = async (db: import("~/server/db").Database) => {
  const { createKernel, defineModule, startPass } =
    await import("~/server/kernel/api");
  const { runOnePass } = await import("~/server/kernel/pass");
  const { retentionPass } = await import("./retention-pass");
  await startPass(db, retentionPass);
  const kernel = createKernel([
    defineModule({
      name: "synthetic.retention",
      entities: [],
      evidence: [],
      asks: [],
      reconcilers: [],
      passes: [retentionPass],
    }),
  ]);
  await runOnePass(db, kernel.registry);
  return () => runOnePass(db, kernel.registry);
};

describe("Execution retention", () => {
  const ctx = withTestDb();

  const subjectLift = async () => {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "object.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const hash = "e".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, row.id));
    const scheduled = await createTransparentDerivativeAndJob(ctx.db, {
      imageId: parseEntityId("image", row.id),
      sourceContentHash: hash,
      key: `pending/${crypto.randomUUID()}.png`,
    });
    if (!scheduled) throw new Error("Expected persisted image work");
    return scheduled.jobId;
  };

  it("reopens an image row a pre-cutover writer left leased", async () => {
    const jobId = await subjectLift();
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "leased", attemptId: crypto.randomUUID() })
      .where(eq(imageProcessingJob.id, jobId));
    await runRetention(ctx.db);
    const [processing] = await getDb(ctx.db)
      .select({ state: imageProcessingJob.state })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    expect(processing?.state).toBe("pending");
  });

  it("prunes terminal Passes while retaining unfinished work", async () => {
    const { seedPass, readPasses } =
      await import("~/server/kernel/pass.fixtures");
    const old = new Date(Date.now() - 20 * 24 * 60 * 60_000);
    for (const key of ["completed", "cancelled", "unfinished"])
      await seedPass(ctx.db, {
        name: "synthetic.retention",
        key,
        updatedAt: old,
        doneAt: key === "completed" ? old : null,
        cancelledAt: key === "cancelled" ? old : null,
      });
    await runRetention(ctx.db);
    expect(
      (await readPasses(ctx.db, { name: "synthetic.retention" })).map(
        (row) => row.key,
      ),
    ).toEqual(["unfinished"]);
  });

  it("advances past a protected page and prunes a superseded receipt on the next page", async () => {
    const { readPasses } = await import("~/server/kernel/pass.fixtures");
    const jobId = await subjectLift();
    const db = getDb(ctx.db);
    await db
      .update(imageProcessingJob)
      .set({ state: "ready" })
      .where(eq(imageProcessingJob.id, jobId));

    const occurredAt = "2020-01-01T00:00:00.000001Z";
    const attemptId = crypto.randomUUID();
    const pageSize = 2_000;
    await db.execute(sql`
      INSERT INTO "ImageProcessingEvent" ("jobId", "eventKey", event, details, "occurredAt")
      SELECT ${jobId}::uuid, 'protected:' || n, 'execution.receipt',
        jsonb_build_object('id', gen_random_uuid()), ${occurredAt}::timestamp
      FROM generate_series(1, ${pageSize}::integer) AS n
      UNION ALL
      SELECT ${jobId}::uuid, 'receipt:1', 'execution.receipt',
        jsonb_build_object('id', ${attemptId}::uuid), ${occurredAt}::timestamp + interval '1 microsecond'
      UNION ALL
      SELECT ${jobId}::uuid, 'receipt:2', 'execution.receipt',
        jsonb_build_object('id', ${attemptId}::uuid), now()::timestamp`);

    const receiptKeys = async () =>
      (
        await db
          .select({ key: imageProcessingEvent.eventKey })
          .from(imageProcessingEvent)
          .where(
            and(
              eq(imageProcessingEvent.jobId, jobId),
              inArray(imageProcessingEvent.eventKey, [
                "receipt:1",
                "receipt:2",
              ]),
            ),
          )
          .orderBy(imageProcessingEvent.eventKey)
      ).map((row) => row.key);
    const runNext = await runRetention(ctx.db);
    expect(await receiptKeys()).toEqual(["receipt:1", "receipt:2"]);
    const [protectedRows] = await db
      .select({ total: count() })
      .from(imageProcessingEvent)
      .where(
        and(
          eq(imageProcessingEvent.jobId, jobId),
          like(imageProcessingEvent.eventKey, "protected:%"),
        ),
      );
    expect(protectedRows?.total).toBe(pageSize);
    const [first] = await readPasses(ctx.db, { name: "retention" });
    expect(first?.cursor).toMatchObject({ occurredAt });
    expect(await runNext()).toBe(true);
    expect(await receiptKeys()).toEqual(["receipt:2"]);
    const [last] = await readPasses(ctx.db, { name: "retention" });
    expect(last?.cursor).toBeNull();
    expect(await runNext()).toBe(false);
  });
});
