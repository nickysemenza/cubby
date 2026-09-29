import {
  createImageProcessingJob,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
} from "~/server/repo/image-processing";
import { createUploadedImageRecord } from "~/server/repo/image";
import {
  markRunFailed,
  startPhotoInventoryRun,
} from "~/server/purchase-import/run-service";
import * as schema from "~/server/db/schema";
import { eq } from "drizzle-orm";
import { parseEntityId } from "@cubby/schemas/identifiers";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ingredientCreateInput } from "@cubby/schemas/ingredient";
import { initiateUploadWithoutEntityResponseSchema } from "@cubby/schemas/image";
import { locationCreateInput } from "@cubby/schemas/location";
import { plantCreateInput } from "@cubby/schemas/plant";
import { plantingCreateInput } from "@cubby/schemas/planting";
import { productCreateInput } from "@cubby/schemas/product";
import {
  expenseCreateInput,
  projectCreateInput,
  taskCreateInput,
} from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { recipeCreateInput } from "@cubby/schemas/recipe";
import { testUserId } from "@cubby/schemas/testing";
import { vendorCreateInput } from "@cubby/schemas/vendor";
import { request } from "@playwright/test";
import type { Pool } from "pg";
import { DEV_USER_EMAIL, DEV_USER_PASSWORD } from "./state";
import type { LocalFixturePack } from "./fixtures";
import {
  buildKernelContext,
  buildScenarioDatabase,
  createFixtureWithContext,
} from "../scenarios/context";

/** Optional packs use the entity kernel, keeping the existing E2E corpus stable. */
export async function seedLocalFixturePack(
  pool: Pool,
  userId: string,
  pack: Exclude<LocalFixturePack, "core">,
  baseURL: string,
): Promise<void> {
  const context = buildKernelContext(
    buildScenarioDatabase(pool),
    testUserId(userId),
  );
  switch (pack) {
    case "recipes": {
      const ingredient = await createFixtureWithContext(
        context,
        "ingredient",
        ingredientCreateInput.parse({
          name: "Synthetic rolled oats",
          aliases: [],
        }),
      );
      await createFixtureWithContext(
        context,
        "recipe",
        recipeCreateInput.parse({
          name: "Synthetic breakfast oats",
          meta: { url: "https://example.com/recipes/oats" },
          servings: 2,
          sections: [
            {
              ingredients: [
                {
                  type: "ingredient",
                  ingredientId: ingredient.id,
                  recipeId: null,
                  amounts: [{ value: 100, unit: "g" }],
                },
              ],
              instructions: [
                { instruction: "Simmer the oats in water until tender." },
              ],
            },
          ],
        }),
      );
      return;
    }
    case "garden": {
      const location = await createFixtureWithContext(
        context,
        "location",
        locationCreateInput.parse({
          name: "Synthetic raised bed",
          type: "room",
          aliases: [],
          tags: [],
          parentId: null,
        }),
      );
      const plant = await createFixtureWithContext(
        context,
        "plant",
        plantCreateInput.parse({
          name: "Synthetic leafy lettuce",
          gardenGuideKey: "lettuce",
        }),
      );
      await createFixtureWithContext(
        context,
        "planting",
        plantingCreateInput.parse({
          plantId: plant.id,
          locationId: location.id,
          status: "planned",
          plannedWindow: "Autumn",
          quantity: "Six starts",
        }),
      );
      return;
    }
    case "calendar": {
      const today = new Date().toISOString().slice(0, 10);
      const project = await createFixtureWithContext(
        context,
        "project",
        projectCreateInput.parse({
          name: "Synthetic seasonal maintenance",
          startDate: today,
          endDate: today,
        }),
      );
      await createFixtureWithContext(
        context,
        "task",
        taskCreateInput.parse({
          name: "Synthetic calendar inspection",
          trade: "other",
          dueDate: today,
          projectId: project.id,
        }),
      );
      await createFixtureWithContext(
        context,
        "expense",
        expenseCreateInput.parse({
          name: "Synthetic planned supplies",
          cost: 12.5,
          date: today,
          future: true,
          trade: "other",
          costType: "materials",
          projectId: project.id,
        }),
      );
      return;
    }
    case "purchase": {
      const vendor = await createFixtureWithContext(
        context,
        "vendor",
        vendorCreateInput.parse({
          name: "Synthetic Fixture Shop",
          aliases: [],
          tags: [],
          website: "https://example.com",
        }),
      );
      const purchase = await createFixtureWithContext(
        context,
        "purchase",
        purchaseCreateInput.parse({
          vendorId: vendor.id,
          orderId: "SYNTHETIC-ORDER-001",
          date: "2026-09-01",
          statedTotal: 24,
          pendingImageIds: [],
        }),
      );
      await createFixtureWithContext(
        context,
        "expense",
        expenseCreateInput.parse({
          name: "Synthetic purchase line",
          cost: 24,
          date: "2026-09-01",
          trade: "other",
          costType: "materials",
          purchaseId: purchase.id,
        }),
      );
      return;
    }
    case "problems": {
      await seedLocalProblemWork(pool, userId, baseURL);
      await createFixtureWithContext(
        context,
        "product",
        productCreateInput.parse({
          name: "Synthetic incomplete product",
          aliases: [],
          tags: [],
          model: null,
          upc: null,
          notes: null,
          expectedQuantity: null,
          ingredientId: null,
          categoryId: null,
        }),
      );
      await createFixtureWithContext(
        context,
        "expense",
        expenseCreateInput.parse({
          name: "Synthetic unlinked expense",
          cost: 8,
          date: "2026-09-01",
          trade: "other",
          costType: "materials",
        }),
      );
      return;
    }
    case "images": {
      const client = await request.newContext({
        baseURL,
        extraHTTPHeaders: { Origin: baseURL },
      });
      try {
        const login = await client.post("/api/auth/sign-in/email", {
          data: { email: DEV_USER_EMAIL, password: DEV_USER_PASSWORD },
        });
        if (!login.ok())
          throw new Error(`Local image fixture auth failed: ${login.status()}`);
        const bytes = await readFile(
          new URL(
            "../../tests/e2e/fixtures/synthetic-wardrobe-shirt.png",
            import.meta.url,
          ),
        );
        const init = await client.post("/api/v1/image/uploadImage", {
          data: {
            filename: "synthetic-fixture-shirt.png",
            contentType: "image/png",
            size: bytes.length,
          },
        });
        if (!init.ok())
          throw new Error(
            `Local image upload initiation failed: ${init.status()} ${await init.text()}`,
          );
        const upload = initiateUploadWithoutEntityResponseSchema.parse(
          await init.json(),
        );
        if (new URL(upload.uploadUrl).origin !== new URL(baseURL).origin)
          throw new Error("Local image upload escaped the local origin");
        const stored = await client.put(upload.uploadUrl, {
          data: bytes,
          headers: { "Content-Type": "image/png" },
        });
        if (!stored.ok())
          throw new Error(
            `Local image storage failed: ${stored.status()} ${await stored.text()}`,
          );
        const final = await client.post("/api/v1/image/markUploaded", {
          data: { id: upload.imageId },
        });
        if (!final.ok())
          throw new Error(
            `Local image finalization failed: ${final.status()} ${await final.text()}`,
          );
      } finally {
        await client.dispose();
      }
      return;
    }
  }
}

/** Durable synthetic history and unqueued pending work preserve the default
 * processing pause. Seeding never dispatches providers or changes maintenance settings. */
async function seedLocalProblemWork(
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

const LOCAL_PROBLEM_FAILED_NOTE = "Synthetic failed photo processing fixture";
const LOCAL_PROBLEM_PENDING_NOTE = "Synthetic pending photo processing fixture";

/** Verifies the durable work states and the real source-image contract. */
async function assertLocalProblemWork(pool: Pool): Promise<void> {
  const runs = await pool.query<{
    notes: string;
    status: string;
    failureCode: string | null;
    endedAt: Date | null;
  }>(
    `SELECT notes, status, "failureCode", "endedAt" FROM "Run" WHERE notes IN ($1, $2) AND "deletedAt" IS NULL`,
    [LOCAL_PROBLEM_FAILED_NOTE, LOCAL_PROBLEM_PENDING_NOTE],
  );
  assert.equal(
    runs.rows.length,
    2,
    "Problems pack must contain explicit failed and pending Runs",
  );
  const failed = runs.rows.find(
    (row) => row.notes === LOCAL_PROBLEM_FAILED_NOTE,
  );
  const pending = runs.rows.find(
    (row) => row.notes === LOCAL_PROBLEM_PENDING_NOTE,
  );
  assert.ok(failed);
  assert.equal(failed.status, "failed");
  assert.equal(failed.failureCode, "flue_failed");
  assert.ok(failed.endedAt, "Failed Run must have terminal timing");
  assert.ok(pending);
  assert.equal(pending.status, "running");
  assert.equal(pending.endedAt, null, "Pending Run must remain open");
  const jobs = await pool.query<{
    state: string;
    source_matches: boolean;
    source_available: boolean;
    lastError: string | null;
  }>(
    `SELECT j.state, j."sourceContentHash" = i.sha256 AS source_matches,
      i.status = 'UPLOADED' AND i."storageStatus" = 'available' AND i."renderStatus" = 'verified' AS source_available,
      j."lastError"
     FROM "ImageProcessingJob" j JOIN "Image" i ON i.id = j."imageId"
     JOIN "Run" r ON r.id = j."runId" WHERE r.notes IN ($1, $2)`,
    [LOCAL_PROBLEM_FAILED_NOTE, LOCAL_PROBLEM_PENDING_NOTE],
  );
  assert.equal(
    jobs.rows.length,
    2,
    "Problems pack must contain failed and pending image jobs",
  );
  assert.deepEqual(jobs.rows.map((row) => row.state).sort(), [
    "failed",
    "pending",
  ]);
  assert.ok(
    jobs.rows.every((row) => row.source_matches && row.source_available),
  );
  assert.match(
    jobs.rows.find((row) => row.state === "failed")?.lastError ?? "",
    /Synthetic provider failure/,
  );
}
