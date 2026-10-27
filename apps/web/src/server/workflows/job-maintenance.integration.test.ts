import { parseEntityId } from "@cubby/schemas/identifiers";
import type { JobId } from "@cubby/schemas/identifiers";
import { eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  entityIdentity,
  image,
  imageProcessingJob,
  job,
} from "~/server/db/schema";
import { createTransparentDerivativeAndJob } from "~/server/domains/image-processing/repo/image-processing";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { JOB_RETENTION_MS } from "~/server/generic/jobs/repo/job-retention";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { advanceJob } from "~/server/generic/jobs/service/jobs";

import { enrollQueueMaintenance } from "./job-maintenance";
import { productionJobHandlers } from "./jobs";

describe("Job maintenance", () => {
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

  const runMaintenance = async () => {
    await enrollQueueMaintenance(ctx.db);
    const [maintenance] = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.key, "jobs.maintenance"));
    if (!maintenance) throw new Error("Expected maintenance Job");
    await getDb(ctx.db)
      .update(job)
      .set({ availableAt: new Date(0) })
      .where(eq(job.id, maintenance.id));
    return advanceJob(ctx.db, maintenance.id, productionJobHandlers);
  };

  it("enrolls one internal jobs.maintenance Job", async () => {
    await enrollQueueMaintenance(ctx.db);
    await enrollQueueMaintenance(ctx.db);
    const rows = await getDb(ctx.db)
      .select({ id: job.id, kind: job.kind })
      .from(job)
      .where(eq(job.key, "jobs.maintenance"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("jobs.maintenance");
  });

  it("repairs stranded image execution", async () => {
    const jobId = await subjectLift();
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "leased", attemptId: crypto.randomUUID() })
      .where(eq(imageProcessingJob.id, jobId));
    await getDb(ctx.db)
      .update(job)
      .set({ state: "failed", error: "Synthetic exhausted execution" })
      .where(eq(job.key, `image-processing:${jobId}`));

    await expect(runMaintenance()).resolves.toBe("succeeded");
    const [processing] = await getDb(ctx.db)
      .select({ state: imageProcessingJob.state })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    const [execution] = await getDb(ctx.db)
      .select({ state: job.state, attempts: job.attempts })
      .from(job)
      .where(eq(job.key, `image-processing:${jobId}`));
    expect(processing?.state).toBe("pending");
    expect(execution).toMatchObject({ state: "queued", attempts: 0 });
  });

  it("prunes old finished Jobs and their entity identities, retaining failures", async () => {
    const old = new Date(Date.now() - JOB_RETENTION_MS - 60_000);
    const retained: JobId[] = [];
    for (const [key, state] of [
      ["synthetic.retention.completed", "completed"],
      ["synthetic.retention.failed", "failed"],
    ] as const) {
      const saved = await enqueueJob(ctx.db, { key, kind: key, input: {} });
      retained.push(saved.id);
      await getDb(ctx.db)
        .update(job)
        .set({ state, updatedAt: old })
        .where(eq(job.id, saved.id));
    }

    await expect(runMaintenance()).resolves.toBe("succeeded");
    expect(
      await getDb(ctx.db).select().from(job).where(eq(job.id, retained[0]!)),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ id: entityIdentity.id })
        .from(entityIdentity)
        .where(inArray(entityIdentity.id, retained)),
    ).toEqual([{ id: retained[1] }]);
    expect(
      await getDb(ctx.db)
        .select({ id: job.id })
        .from(job)
        .where(eq(job.id, retained[1]!)),
    ).toEqual([{ id: retained[1] }]);
  });
});
