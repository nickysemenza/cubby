import type { ImageProcessingJobKind } from "@cubby/schemas/image-processing";
import { askState } from "@cubby/schemas/kernel/machinery";
import { eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { imageProcessingJob } from "~/server/db/image-processing-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import type { ImageExecutionResult } from "~/server/domains/image-processing/module";
import type { AskKind } from "~/server/kernel/api";

/** The request receipt and Ask share their initial identity, which the device wire exposes. */
export async function queueImageAsk(
  db: Database,
  job: typeof imageProcessingJob.$inferSelect,
): Promise<{
  id: string;
  kind: AskKind<
    {
      receiptId: string;
      imageId: string;
      sourceContentHash: string;
      processorRevision: number;
      kind: ImageProcessingJobKind;
      generation: number;
    },
    ImageExecutionResult
  >;
}> {
  const { deviceImageAsk, cloudImageAsk } =
    await import("~/server/domains/image-processing/module");
  const { queueAsk } = await import("~/server/kernel/api");
  const kind = job.lane === "device" ? deviceImageAsk : cloudImageAsk;
  if (job.askId) return { id: job.askId, kind };
  const id = await queueAsk(
    db,
    kind,
    {
      receiptId: job.id,
      imageId: job.imageId,
      sourceContentHash: job.sourceContentHash,
      processorRevision: job.processorRevision,
      kind: job.kind,
      generation: job.attempts,
    },
    { runId: job.runId, record: { entity: "image", id: job.imageId } },
    job.attempts === 0 ? job.id : undefined,
  );
  await queueAsk(
    db,
    kind,
    {
      receiptId: job.id,
      imageId: job.imageId,
      sourceContentHash: job.sourceContentHash,
      processorRevision: job.processorRevision,
      kind: job.kind,
      generation: job.attempts,
    },
    { record: { entity: "imageJob", id: job.id } },
  );
  await repositoryQueries(db)
    .update(imageProcessingJob)
    .set({ askId: id })
    .where(eq(imageProcessingJob.id, job.id));
  if (job.lane === "cloud") {
    await queueAsk(
      db,
      kind,
      {
        receiptId: job.id,
        imageId: job.imageId,
        sourceContentHash: job.sourceContentHash,
        processorRevision: job.processorRevision,
        kind: job.kind,
        generation: job.attempts,
      },
      { pass: { name: "image.cloud", key: id } },
    );
    const { startPass } = await import("~/server/kernel/api");
    await startPass(db, "image.cloud", {
      key: id,
      cursor: { jobId: job.id, askId: id },
      runId: job.runId,
    });
  }
  return { id, kind };
}

export async function cloudAskPassState(
  db: Database,
  jobId: string,
): Promise<{ done: boolean; unknown: boolean } | undefined> {
  const result = await repositoryQueries(db).execute<{
    done: boolean;
    unknown: boolean;
  }>(
    sql`SELECT state=${askState.enum.answered} OR "cancelledAt" IS NOT NULL AS done,state=${askState.enum.unknown} AS unknown FROM "Ask" WHERE id=${jobId}::uuid`,
  );
  return result.rows[0];
}
