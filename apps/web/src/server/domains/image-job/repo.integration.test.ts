import { parseEntityId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  aiUsage,
  imageProcessingAttempt,
  imageProcessingJob,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import {
  createImageFixture,
  insertEntityFixtures,
} from "~/server/testing/repo.fixtures";

describe("image job cost", () => {
  const ctx = withTestDb();

  const job = async () => {
    const image = await createImageFixture(
      ctx.db,
      `synthetic-job-cost-${crypto.randomUUID()}`,
    );
    const [row] = await insertEntityFixtures(
      ctx.db,
      imageProcessingJob,
      "imageJob",
      [
        {
          shortcode: generateShortcode("imageJob"),
          imageId: parseEntityId("image", image.id),
          kind: "describe_image",
          state: "ready",
          sourceContentHash: "b".repeat(64),
          processorRevision: 1,
        },
      ],
    );
    if (!row) throw new Error("fixture: image job not created");
    return row;
  };

  // Regression: the per-attempt and per-kind usage sources were one OR whose
  // attempt-id IN list could not use the (jobKind, jobId) index. The rewrite
  // must still count both sources, once each, and skip deleted usage.
  it("sums attempt and job-kind usage once each, excluding deleted and other jobs' usage", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const target = await job();
    const other = await job();
    const attempts = [crypto.randomUUID(), crypto.randomUUID()];
    await getDb(ctx.db)
      .insert(imageProcessingAttempt)
      .values(
        attempts.map((id, index) => ({
          id,
          jobId: target.id,
          number: index + 1,
          state: "ready",
        })),
      );
    const usage = (
      jobKind: string,
      jobId: string,
      chargedCost: number,
      deletedAt: Date | null = null,
    ) => ({
      runId,
      jobKind,
      jobId,
      feature: "synthetic-image",
      provider: "test",
      model: "test-model",
      operation: "describe",
      chargedCost,
      standardCost: chargedCost * 2,
      status: "succeeded" as const,
      durationMs: 1,
      deletedAt,
    });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values([
        usage("image_processing_attempt", attempts[0]!, 0.25),
        usage("image_processing_attempt", attempts[1]!, 0.5),
        usage("describe_image", target.id, 1),
        usage("describe_image", target.id, 8, new Date()),
        usage("describe_image", other.id, 16),
      ]);
    const read = await executeEntity(
      kernelCtx(ctx),
      entityCommandSchema.parse({
        action: "get",
        entity: "imageJob",
        id: target.shortcode,
      }),
    );
    expect(read).toMatchObject({
      item: { chargedCost: 1.75, standardCost: 3.5 },
    });
  });
});
