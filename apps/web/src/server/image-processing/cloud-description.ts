import type { ImageId, RunId } from "@cubby/schemas/identifiers";
import {
  IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
  IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import { providerFor } from "@cubby/shared/ai/models";

import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import type { Database } from "~/server/db";
import {
  completeImageProcessingJob,
  findImageProcessingWakeupsForImage,
} from "~/server/repo/image-processing";
import { refreshDirectImageOwnerSearchDocuments } from "~/server/repo/search-document";
import { ensureRun, systemActor } from "~/server/runs/ensure-run";
import { describeOriginalImage } from "~/server/services/image-description.service";

/** The same cloud policy, immutable history, and followups for edge and companion JPEG inputs. */
export async function completeCloudImageDescription(
  db: Database,
  input: {
    jobId: string;
    attemptId: string;
    imageId: ImageId;
    runId: RunId | null;
    normalizedInput?: Parameters<
      typeof describeOriginalImage
    >[1]["normalizedInput"];
  },
) {
  // Use the run that requested this job when one was recorded at
  // scheduling time, so its AI usage is attributed to that run's actor
  // rather than a fresh background run. No user rides along with a job
  // that has none, so it books under the system actor like every other
  // background AI call.
  const runId =
    input.runId ??
    (await ensureRun(db, systemActor(), {
      purpose: "background",
    }));
  const { result, fingerprint } = await describeOriginalImage(db, {
    imageId: input.imageId,
    attemptId: input.attemptId,
    runId,
    normalizedInput: input.normalizedInput,
  });
  const completion = await completeImageProcessingJob(db, {
    result: {
      jobId: input.jobId,
      attemptId: input.attemptId,
      completedAt: new Date().toISOString(),
      outcome: {
        kind: "describe_image",
        status: "completed",
        description: result,
        runtime: {
          platform: "cloud",
          model: IMAGE_DESCRIPTION_FEATURE.model,
        },
      },
    },
    cloudAnalysis: {
      provider: providerFor(IMAGE_DESCRIPTION_FEATURE.model),
      model: IMAGE_DESCRIPTION_FEATURE.model,
      promptRevision: IMAGE_CLOUD_DESCRIPTION_PROMPT_REVISION,
      resultSchemaRevision: IMAGE_CLOUD_DESCRIPTION_RESULT_SCHEMA_REVISION,
      inputFingerprint: fingerprint,
    },
    runtime: {
      provider: providerFor(IMAGE_DESCRIPTION_FEATURE.model),
      model: IMAGE_DESCRIPTION_FEATURE.model,
      feature: "image-description",
    },
  });
  if (!completion.adopted) return false;
  await refreshDirectImageOwnerSearchDocuments(db, input.imageId);
  const { publishImageProcessingWakeups } =
    await import("~/server/services/image-processing.service");
  await publishImageProcessingWakeups(
    db,
    await findImageProcessingWakeupsForImage(db, input.imageId),
  );
  return true;
}
