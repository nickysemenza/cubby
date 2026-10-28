import { parseEntityId } from "@cubby/schemas/identifiers";
import type { JobId } from "@cubby/schemas/identifiers";
import { eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import { entityIdentity, image, imageProcessingJob } from "~/server/db/schema";
import { createTransparentDerivativeAndJob } from "~/server/domains/image-processing/repo/image-processing";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import {
  JOB_RETENTION_MS,
  pruneFinishedJobs,
} from "~/server/generic/jobs/repo/job-retention";
import { enqueueJob, wakeJob } from "~/server/generic/jobs/repo/producer";
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
    const [maintenance] = await readJobs(ctx.db, { key: "jobs.maintenance" });
    if (!maintenance) throw new Error("Expected maintenance Job");
    await updateJobs(
      ctx.db,
      { id: maintenance.id },
      { availableAt: new Date(0) },
    );
    return advanceJob(ctx.db, maintenance.id, productionJobHandlers);
  };

  it("enrolls one internal jobs.maintenance Job", async () => {
    await enrollQueueMaintenance(ctx.db);
    await enrollQueueMaintenance(ctx.db);
    const rows = await readJobs(ctx.db, { key: "jobs.maintenance" }).then(
      (rows) => rows.map(({ id, kind }) => ({ id, kind })),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("jobs.maintenance");
  });

  it("repairs stranded image execution", async () => {
    const jobId = await subjectLift();
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "leased", attemptId: crypto.randomUUID() })
      .where(eq(imageProcessingJob.id, jobId));
    await updateJobs(
      ctx.db,
      { key: `image-processing:${jobId}` },
      { state: "failed", error: "Synthetic exhausted execution" },
    );

    await expect(runMaintenance()).resolves.toBe("succeeded");
    const [processing] = await getDb(ctx.db)
      .select({ state: imageProcessingJob.state })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    const [execution] = await readJobs(ctx.db, {
      key: `image-processing:${jobId}`,
    }).then((rows) => rows.map(({ attempts, state }) => ({ state, attempts })));
    expect(processing?.state).toBe("pending");
    expect(execution).toMatchObject({ state: "queued", attempts: 0 });
  });

  it("keeps a drain while a producer commits a fresh wake", async () => {
    const input = {
      key: "synthetic.retention.wake",
      kind: "synthetic.retention",
      input: {},
    };
    const saved = await enqueueJob(ctx.db, input);
    await updateJobs(
      ctx.db,
      { id: saved.id },
      {
        state: "completed",
        updatedAt: new Date(Date.now() - JOB_RETENTION_MS - 60_000),
      },
    );
    const woken = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const producer = withTransactionDatabase(ctx.db, async (tx) => {
      await wakeJob(tx, input);
      woken.resolve();
      await release.promise;
    });
    try {
      await woken.promise;
      expect(await pruneFinishedJobs(ctx.db, { limit: 100 })).toBe(0);
    } finally {
      release.resolve();
      await producer;
    }
    expect(await pruneFinishedJobs(ctx.db, { limit: 100 })).toBe(0);
    expect(
      await readJobs(ctx.db, { id: saved.id }).then((rows) =>
        rows.map(({ id }) => ({ id })),
      ),
    ).toEqual([{ id: saved.id }]);
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
      await updateJobs(ctx.db, { id: saved.id }, { state, updatedAt: old });
    }

    await expect(runMaintenance()).resolves.toBe("succeeded");
    expect(await readJobs(ctx.db, { id: retained[0]! })).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select({ id: entityIdentity.id })
        .from(entityIdentity)
        .where(inArray(entityIdentity.id, retained)),
    ).toEqual([{ id: retained[1] }]);
    expect(
      await readJobs(ctx.db, { id: retained[1]! }).then((rows) =>
        rows.map(({ id }) => ({ id })),
      ),
    ).toEqual([{ id: retained[1] }]);
  });
});
