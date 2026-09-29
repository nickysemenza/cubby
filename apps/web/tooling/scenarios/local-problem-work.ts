import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { testUserId } from "@cubby/schemas/testing";
import { eq } from "drizzle-orm";
import type { Pool } from "pg";
import * as schema from "~/server/db/schema";
import {
  markRunFailed,
  startPhotoInventoryRun,
} from "~/server/purchase-import/run-service";
import { createUploadedImageRecord } from "~/server/repo/image";
import {
  createImageProcessingJob,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
} from "~/server/repo/image-processing";
import {
  assertLocalProblemWork,
  LOCAL_PROBLEM_FAILED_NOTE,
  LOCAL_PROBLEM_PENDING_NOTE,
} from "../local-problem-work-check.ts";
import { buildScenarioDatabase } from "./context";

/** Durable synthetic history and unqueued pending work preserve the default
 * processing pause. Seeding never dispatches providers or changes maintenance settings. */
export async function seedLocalProblemWork(
  pool: Pool,
  userId: string,
  baseURL: string,
): Promise<void> {
  const db = buildScenarioDatabase(pool);
  const database = db.clientForRepository();
  const bytes = await readFile(
    new URL(
      "../../tests/e2e/fixtures/synthetic-wardrobe-shirt.png",
      import.meta.url,
    ),
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  for (const state of ["failed", "pending"] as const) {
    const note =
      state === "failed"
        ? LOCAL_PROBLEM_FAILED_NOTE
        : LOCAL_PROBLEM_PENDING_NOTE;
    const run = await startPhotoInventoryRun(db, {
      actorUserId: testUserId(userId),
      notes: note,
    });
    await database
      .update(schema.run)
      .set({ status: "running", startedAt: new Date() })
      .where(eq(schema.run.id, run.id));
    const key = `${process.env.R2_KEY_PREFIX ?? "cubby-local"}/fixtures/problems-${state}-${randomUUID()}.png`;
    const bucket = process.env.R2_BUCKET_NAME ?? "cubby-local";
    const upload = await fetch(
      `${baseURL}/__local-storage/s3/${encodeURIComponent(bucket)}/${key}`,
      { method: "PUT", headers: { "Content-Type": "image/png" }, body: bytes },
    );
    if (!upload.ok)
      throw new Error(
        `Problem fixture source upload failed: ${upload.status} ${await upload.text()}`,
      );
    const source = await createUploadedImageRecord(db, {
      key,
      filename: `synthetic-problems-${state}.png`,
      contentType: "image/png",
      size: bytes.length,
      width: 640,
      height: 640,
      detectedContentType: "image/png",
      sha256,
      renderStatus: "verified",
      storageStatus: "available",
      verifiedAt: new Date(),
    });
    const jobId = await createImageProcessingJob(db, {
      imageId: parseEntityId("image", source.id),
      kind: "describe_image",
      sourceContentHash: sha256,
      processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
      runId: run.id,
    });
    if (!jobId)
      throw new Error(
        "Problem fixture image is not an uploaded current source",
      );
    if (state === "failed") {
      const reason =
        "Synthetic provider failure: fixture image analysis did not complete";
      await database
        .update(schema.imageProcessingJob)
        .set({
          state: "failed",
          attempts: 1,
          lastError: reason,
          completedAt: new Date(),
        })
        .where(eq(schema.imageProcessingJob.id, jobId));
      await database.insert(schema.imageProcessingAttempt).values({
        id: randomUUID(),
        jobId,
        number: 1,
        state: "failed",
        executor: {
          kind: "cloud",
          deviceId: null,
          name: "Synthetic fixture provider",
          platform: "cloud",
          appVersion: null,
          osVersion: null,
        },
        diagnostics: {
          provider: "synthetic",
          model: "synthetic-vision",
          inputAvailability: "Stored local synthetic PNG",
        },
        result: {
          kind: "describe_image",
          status: "failed",
          retryable: true,
          reason,
        },
        error: reason,
        completedAt: new Date(),
      });
      const terminal = await markRunFailed(db, {
        runId: run.id,
        failureCode: "flue_failed",
        detail: reason,
      });
      if (!terminal.failed)
        throw new Error(
          "Problem fixture run failed to reach its terminal state",
        );
    }
  }
  await assertLocalProblemWork(pool);
}
