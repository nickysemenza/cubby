import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { imageProcessingJob, image } from "~/server/db/schema";

import { getDb, notDeleted } from "./database-helpers";
import { IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION } from "./image-processing";

/** Routing is advisory; the destination claims and rechecks all source/revision/pause fences. */
export async function readImageCloudQueueRoute(db: Database, jobId: string) {
  const [row] = await getDb(db)
    .select({
      kind: imageProcessingJob.kind,
      processorRevision: imageProcessingJob.processorRevision,
      contentType: image.contentType,
      requestedAt: imageProcessingJob.createdAt,
    })
    .from(imageProcessingJob)
    .innerJoin(
      image,
      and(
        eq(image.id, imageProcessingJob.imageId),
        notDeleted(image),
        eq(image.status, "UPLOADED"),
        eq(image.sha256, imageProcessingJob.sourceContentHash),
      ),
    )
    .where(and(eq(imageProcessingJob.id, jobId)))
    .limit(1);
  const cloud =
    row?.kind === "identify_image" ||
    (row?.kind === "describe_image" &&
      row.processorRevision !== IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION &&
      row.contentType !== "image/avif");
  return cloud && row ? { requestedAt: row.requestedAt.toISOString() } : null;
}

export async function readImageProcessingQueuedAt(db: Database, jobId: string) {
  const [row] = await getDb(db)
    .select({ createdAt: imageProcessingJob.createdAt })
    .from(imageProcessingJob)
    .where(eq(imageProcessingJob.id, jobId))
    .limit(1);
  return row?.createdAt.toISOString() ?? null;
}
