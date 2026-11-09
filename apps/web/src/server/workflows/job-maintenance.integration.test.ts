import { parseEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { image, imageProcessingJob, run as runTable } from "~/server/db/schema";
import { createTransparentDerivativeAndJob } from "~/server/domains/image-processing/repo/image-processing";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { readJobs } from "~/server/generic/jobs/repo/job-reads";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";

import { maintainJobs } from "./job-maintenance";

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

  it("reopens an image row a pre-cutover writer left leased", async () => {
    const jobId = await subjectLift();
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "leased", attemptId: crypto.randomUUID() })
      .where(eq(imageProcessingJob.id, jobId));
    await maintainJobs(ctx.db);
    const [processing] = await getDb(ctx.db)
      .select({ state: imageProcessingJob.state })
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, jobId));
    expect(processing?.state).toBe("pending");
  });

  it("prunes terminal Jobs only after their retention window", async () => {
    const old = new Date(Date.now() - 9 * 24 * 60 * 60_000);
    const retained: string[] = [];
    for (const [key, state] of [
      ["synthetic.retention.completed", "completed"],
      ["synthetic.retention.failed", "failed"],
      ["synthetic.retention.cancelled", "cancelled"],
    ] as const) {
      const saved = await enqueueJob(ctx.db, { key, kind: key, input: {} });
      retained.push(saved.id);
      await updateJobs(ctx.db, { id: saved.id }, { state, updatedAt: old });
    }

    const expired = await enqueueJob(ctx.db, {
      key: "synthetic.retention.expired-failure",
      kind: "synthetic.retention",
      input: {},
    });
    await updateJobs(
      ctx.db,
      { id: expired.id },
      {
        state: "failed",
        updatedAt: new Date(Date.now() - 31 * 24 * 60 * 60_000),
      },
    );
    await maintainJobs(ctx.db);
    expect(await readJobs(ctx.db, { id: expired.id })).toEqual([]);
    expect(await readJobs(ctx.db, { id: retained[0]! })).toEqual([]);
    expect(
      await readJobs(ctx.db, { id: retained[1]! }).then((rows) =>
        rows.map(({ id }) => ({ id })),
      ),
    ).toEqual([{ id: retained[1] }]);
    expect(await readJobs(ctx.db, { id: retained[2]! })).toHaveLength(1);
  });

  it("prunes old failed Jobs only for settled automatic Runs and keeps the Run", async () => {
    const old = new Date(Date.now() - 15 * 24 * 60 * 60_000);
    const seed = async (
      key: string,
      run: {
        purpose: "maintenance" | "mail_search";
        trigger: "manual" | "scheduled";
      },
    ) => {
      const runId = await ensureRun(ctx.db, ctx.actor, {
        ...run,
        status: "completed",
        execution: false,
      });
      const saved = await enqueueJob(ctx.db, {
        key,
        kind: "synthetic.retention",
        input: {},
        runId,
      });
      await updateJobs(
        ctx.db,
        { id: saved.id },
        { state: "failed", updatedAt: old },
      );
      return { jobId: saved.id, runId };
    };
    const automatic = await seed("synthetic.failed.automatic", {
      purpose: "maintenance",
      trigger: "scheduled",
    });
    const manual = await seed("synthetic.failed.manual", {
      purpose: "maintenance",
      trigger: "manual",
    });
    const mail = await seed("synthetic.failed.mail", {
      purpose: "mail_search",
      trigger: "scheduled",
    });
    await maintainJobs(ctx.db);
    expect(await readJobs(ctx.db, { id: automatic.jobId })).toEqual([]);
    expect(await readJobs(ctx.db, { id: manual.jobId })).toHaveLength(1);
    expect(await readJobs(ctx.db, { id: mail.jobId })).toHaveLength(1);
    const [run] = await getDb(ctx.db)
      .select({ id: runTable.id })
      .from(runTable)
      .where(eq(runTable.id, automatic.runId));
    expect(run?.id).toBe(automatic.runId);
  });
});
