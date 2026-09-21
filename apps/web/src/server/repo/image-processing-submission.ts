import type { ImageProcessingJobKind } from "@cubby/schemas/image-processing";

import type { Database } from "~/server/db";
import { withTransactionDatabase } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import {
  getUploadedImageProcessingSource,
  createTransparentDerivativeAndJob,
  createImageProcessingJob,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
} from "./image-processing";
import {
  createImageProcessingSubmission,
  attachSubmissionJobs,
  lockImageProcessingSubmissionSource,
} from "./image-processing-history";

type ScheduledImageProcessing = { jobIds: string[]; submissionId?: string };

/** Membership and job insertion share the image lock and transaction. */
export async function persistImageProcessingSubmission(
  db: Database,
  input: {
    id: string;
    kinds: readonly ImageProcessingJobKind[];
    automatic?: boolean;
    submission?: { id: string; publicId: string };
  },
): Promise<ScheduledImageProcessing> {
  return withTransactionDatabase(db, async (transactionDb) => {
    const imageId = await resolveOrThrow(transactionDb, "image", input.id);
    const existingIds = await lockImageProcessingSubmissionSource(
      transactionDb,
      imageId,
    );
    const source = await getUploadedImageProcessingSource(
      transactionDb,
      imageId,
    );
    if (!source)
      throw new Error("Image must be uploaded and integrity-verified first");
    const submission = input.automatic
      ? null
      : (input.submission ??
        (await createImageProcessingSubmission(transactionDb)));
    const jobIds: string[] = [];
    for (const kind of new Set(input.kinds)) {
      if (kind === "subject_lift") {
        const scheduled = await createTransparentDerivativeAndJob(
          transactionDb,
          {
            imageId,
            sourceContentHash: source.sha256,
            // Every actual dispatch rotates this placeholder to a fresh key.
            key: `pending/${crypto.randomUUID()}.png`,
          },
        );
        if (scheduled) jobIds.push(scheduled.jobId);
        continue;
      }
      const jobId = await createImageProcessingJob(transactionDb, {
        imageId,
        kind,
        sourceContentHash: source.sha256,
        processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
      });
      if (jobId) jobIds.push(jobId);
    }
    const unique = [...new Set(jobIds)];
    if (submission)
      await attachSubmissionJobs(
        transactionDb,
        submission.id,
        unique,
        existingIds,
      );
    const result: ScheduledImageProcessing = { jobIds: unique };
    if (submission) result.submissionId = submission.publicId;
    return result;
  });
}

export async function persistAppleImageDescriptionSubmission(
  db: Database,
  input: { id: string },
): Promise<{ jobId: string | null }> {
  return withTransactionDatabase(db, async (transactionDb) => {
    const imageId = await resolveOrThrow(transactionDb, "image", input.id);
    const existingIds = await lockImageProcessingSubmissionSource(
      transactionDb,
      imageId,
    );
    const source = await getUploadedImageProcessingSource(
      transactionDb,
      imageId,
    );
    if (!source)
      throw new Error("Image must be uploaded and integrity-verified first");
    const submission = await createImageProcessingSubmission(transactionDb);
    const jobId = await createImageProcessingJob(transactionDb, {
      imageId,
      kind: "describe_image",
      sourceContentHash: source.sha256,
      processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
    });
    if (jobId)
      await attachSubmissionJobs(
        transactionDb,
        submission.id,
        [jobId],
        existingIds,
      );
    return { jobId };
  });
}
