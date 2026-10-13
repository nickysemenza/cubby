import type { ImageId, RunId } from "@cubby/schemas/identifiers";
import {
  IMAGE_IDENTIFICATION_MODEL,
  IMAGE_IDENTIFICATION_PROMPT_REVISION,
  IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-identification";
import { providerFor } from "@cubby/shared/ai/models";

import type { Database } from "~/server/db";
import { completeImageProcessingJob } from "~/server/repo/image-processing";
import { ensureRun, systemActor } from "~/server/runs/ensure-run";
import { identifyOriginalImage } from "~/server/services/image-identification.service";

/** Decisions are persisted only inside the current source/lease adoption transaction. */
export async function completeCloudImageIdentification(
  db: Database,
  input: {
    jobId: string;
    attemptId: string;
    imageId: ImageId;
    runId: RunId | null;
  },
): Promise<boolean> {
  const runId =
    input.runId ??
    (await ensureRun(db, systemActor(), { purpose: "background" }));
  const { result, fingerprint } = await identifyOriginalImage(db, {
    imageId: input.imageId,
    attemptId: input.attemptId,
    runId,
  });
  const provider = providerFor(IMAGE_IDENTIFICATION_MODEL);
  const completion = await completeImageProcessingJob(db, {
    result: {
      jobId: input.jobId,
      attemptId: input.attemptId,
      completedAt: new Date().toISOString(),
      outcome: {
        kind: "identify_image",
        status: "completed",
        identification: result,
      },
    },
    identificationAnalysis: {
      provider,
      model: IMAGE_IDENTIFICATION_MODEL,
      promptRevision: IMAGE_IDENTIFICATION_PROMPT_REVISION,
      resultSchemaRevision: IMAGE_IDENTIFICATION_RESULT_SCHEMA_REVISION,
      inputFingerprint: fingerprint,
    },
    runtime: {
      provider,
      model: IMAGE_IDENTIFICATION_MODEL,
      feature: "image-identification",
    },
  });
  return completion.adopted;
}
