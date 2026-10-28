import { entityFieldEnvelopeSchemas } from "@cubby/schemas/entity-field-envelopes";
import { fieldValueOf } from "@cubby/schemas/field-envelope";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import { job as durableJob } from "~/server/db/retained-tables";
import {
  aiUsage,
  imageProcessingAttempt,
  imageProcessingJob,
} from "~/server/db/schema";
import { readDeviceBacklog } from "~/server/domains/image-processing/repo/device-backlog";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { getConnectedRecords } from "~/server/generic/entity-links/repo/connected-records";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createImageFixture,
  insertEntityFixtures,
} from "~/server/testing/repo.fixtures";

describe("image job cost", () => {
  const ctx = withTestDb();

  const job = async (state: "ready" | "pending" = "ready") => {
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
          state,
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
    const { item } = z
      .object({ item: entityFieldEnvelopeSchemas.imageJob.detail })
      .parse(read);
    expect(fieldValueOf(item.fields.chargedCost)).toBe(1.75);
    expect(fieldValueOf(item.fields.standardCost)).toBe(3.5);
  });

  it("shows the Device holding a live lease, its expiry, and the device backlog", async () => {
    const installationId = crypto.randomUUID();
    const device = await insertWithShortcode(ctx.db, "device", {
      name: "Synthetic Mac",
      installationId,
      platform: "macos",
    });
    const held = await job("pending");
    const parked = await job("pending");
    const attemptId = crypto.randomUUID();
    await getDb(ctx.db)
      .insert(imageProcessingAttempt)
      .values({
        id: attemptId,
        jobId: held.id,
        number: 1,
        state: "leased",
        executor: {
          kind: "device",
          deviceId: installationId,
          name: "Synthetic Mac",
          platform: "macos",
          appVersion: "1",
          osVersion: "26",
        },
      });
    // A reclaim within the window is a second claim of the same Job.
    await getDb(ctx.db)
      .insert(imageProcessingAttempt)
      .values({
        id: crypto.randomUUID(),
        jobId: held.id,
        number: 2,
        state: "expired",
        executor: {
          kind: "device",
          deviceId: installationId,
          name: "Synthetic Mac",
          platform: "macos",
          appVersion: "1",
          osVersion: "26",
        },
      });
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    const heldExecution = await enqueueJob(ctx.db, {
      key: `image-processing:${held.id}`,
      kind: "image.device",
      input: {},
    });
    await getDb(ctx.db)
      .update(durableJob)
      .set({
        state: "running",
        leaseToken: attemptId,
        leaseExpiresAt,
        lastClaimedAt: new Date(),
      })
      .where(eq(durableJob.id, heldExecution.id));
    await enqueueJob(ctx.db, {
      key: `image-processing:${parked.id}`,
      kind: "image.device",
      input: {},
    });
    const read = async (shortcode: string) =>
      executeEntity(
        kernelCtx(ctx),
        entityCommandSchema.parse({
          action: "get",
          entity: "imageJob",
          id: shortcode,
        }),
      );
    const reply = z.object({
      item: entityFieldEnvelopeSchemas.imageJob.detail,
    });
    const active = reply.parse(await read(held.shortcode)).item;
    expect(fieldValueOf(active.fields.state)).toBe("leased");
    expect(active.leaseDeviceId).toBe(device.shortcode);
    expect(fieldValueOf(active.fields.leaseExpiresAt)).toEqual(leaseExpiresAt);
    const waiting = reply.parse(await read(parked.shortcode)).item;
    expect(waiting.leaseDeviceId).toBeNull();
    expect(fieldValueOf(waiting.fields.leaseExpiresAt)).toBeNull();
    expect(await readDeviceBacklog(ctx.db)).toMatchObject({
      waiting: 1,
      workingDevices: 1,
      claimsPerMinute: 0.2,
      etaSeconds: 300,
    });
    const source = {
      entityKind: "imageJob" as const,
      entityId: held.shortcode,
    };
    const devices = () =>
      getConnectedRecords(ctx.db, { source, viewKey: "entity:device" });
    expect((await devices()).items.map((item) => item.target.entityId)).toEqual(
      [device.shortcode],
    );
    const execution = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "entity:job",
    });
    expect(execution.items.map((item) => item.target.entityId)).toEqual([
      heldExecution.shortcode,
    ]);
    await getDb(ctx.db)
      .update(durableJob)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(durableJob.id, heldExecution.id));
    expect((await devices()).totalCount).toBe(1);
    await getDb(ctx.db)
      .update(durableJob)
      .set({ state: "queued", leaseToken: null, leaseExpiresAt: null })
      .where(eq(durableJob.id, heldExecution.id));
    expect((await devices()).totalCount).toBe(0);
  });
});
