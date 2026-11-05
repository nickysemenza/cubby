import {
  type ImageJobId,
  parseEntityId,
  type RunId,
} from "@cubby/schemas/identifiers";
import { IMAGE_PROCESSING_PROTOCOL_VERSION } from "@cubby/schemas/image-processing";
import { eq, sql } from "drizzle-orm";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  image,
  imageProcessingAttempt,
  imageProcessingEvent,
  imageProcessingJob,
} from "~/server/db/schema";
import { createDevice } from "~/server/domains/device/repo/device";
import {
  readImageExecutions,
  updateImageExecution,
} from "~/server/domains/image-processing/repo/image-execution.fixtures";
import * as companionDispatch from "~/server/domains/image-processing/service/dispatch";
import {
  claimCompanionImageCommands,
  pullCompanionImageProcessing,
} from "~/server/domains/image-processing/service/image-processing.service";
import { createUploadedImageRecord } from "~/server/domains/image/repo/image";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";

import {
  claimImageProcessingJob,
  completeImageProcessingJob,
  createImageProcessingJob,
  IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  releaseAssignedImageProcessingJob,
  renewAssignedImageProcessingLease,
} from "./image-processing";
import { assignImageProcessingExecutor } from "./image-processing-history";

// Devices claim parked device work directly, honoring its backoff, and never
// steal cloud jobs. A 60 s lease is renewed by heartbeat; release is never an
// attempt and the retry prefers another device; a result after expiry is
// adopted while no newer attempt claimed the work.
describe("background companion leases", () => {
  const ctx = withTestDb();
  const userId = "synthetic-background-user";
  const deviceId = parseEntityId("device", crypto.randomUUID());
  async function job(
    processorRevision: number,
    contentType = "image/jpeg",
    runId: RunId | null = null,
  ) {
    const row = await createUploadedImageRecord(ctx.db, {
      key: `tests/${crypto.randomUUID()}.jpg`,
      filename: "panel.jpg",
      contentType,
      size: 512,
    });
    const hash = "b".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: hash })
      .where(eq(image.id, row.id));
    const created = await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", row.id),
      kind: "describe_image",
      sourceContentHash: hash,
      processorRevision,
      runId,
    });
    if (!created) throw new Error("Expected job");
    return created;
  }
  const claim = (fromDevice = deviceId) =>
    claimImageProcessingJob(ctx.db, {
      kinds: ["describe_image"],
      leaseMs: 60_000,
      processorRevisions: [IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION],
      deviceId: fromDevice,
    });
  const assign = (
    lease: { id: ImageJobId; attemptId: string },
    toDevice = deviceId,
  ) =>
    assignImageProcessingExecutor(ctx.db, {
      jobId: lease.id,
      attemptId: lease.attemptId,
      userId,
      executor: {
        kind: "device",
        deviceId: toDevice,
        name: "Test phone",
        platform: "ios",
        appVersion: "1",
        osVersion: "26",
      },
    });
  const expire = (jobId: ImageJobId) =>
    updateImageExecution(ctx.db, jobId, {
      leaseUntil: new Date(Date.now() - 1_000),
    });
  const failure = (lease: { id: ImageJobId; attemptId: string }) => ({
    result: {
      jobId: lease.id,
      attemptId: lease.attemptId,
      completedAt: new Date().toISOString(),
      outcome: {
        kind: "describe_image" as const,
        status: "failed" as const,
        reason: "Synthetic late device failure",
        retryable: true,
      },
    },
  });

  const hello = (
    installationId = parseEntityId("device", crypto.randomUUID()),
  ) =>
    ({
      protocolVersion: IMAGE_PROCESSING_PROTOCOL_VERSION,
      type: "hello",
      deviceId: installationId,
      platform: "ios",
      appVersion: "1",
      participation: { automaticWork: true },
      capabilities: {
        foreground: true,
        visionSubjectLift: { available: false },
        actualImageDescription: { available: true, revision: 1 },
      },
    }) as const;
  const batchPull = (maxCommands?: number) =>
    pullCompanionImageProcessing(
      ctx.db,
      { hello: hello(), leaseSeconds: 60, maxCommands },
      userId,
    );

  it("fills a batch with an active Run's work first and keeps the legacy first command", async () => {
    const owner = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const owned: string[] = [];
    for (let index = 0; index < 8; index++)
      owned.push(
        await job(
          IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
          "image/jpeg",
          owner,
        ),
      );
    const pulled = await batchPull(8);
    expect(pulled.commands).toHaveLength(8);
    expect(pulled.command).toEqual(pulled.commands[0]);
    const order = pulled.commands.map((command) => command.jobId);
    expect(order.every((id) => owned.includes(id))).toBe(true);
    expect(order).not.toContain(backfill);
    expect(new Set(order).size).toBe(8);
    const attempts = await getDb(ctx.db).select().from(imageProcessingAttempt);
    expect(attempts).toHaveLength(8);
    expect(attempts.every((attempt) => attempt.state === "running")).toBe(true);
  });

  it("finalizes leases expired while preparing later items without handing a job off twice", async () => {
    const owner = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const jobs = [
      await job(
        IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
        "image/jpeg",
        owner,
      ),
      await job(
        IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
        "image/jpeg",
        owner,
      ),
    ];
    const prepare = companionDispatch.prepareCompanionImageCommand;
    let prepared = 0;
    let firstDeadline = 0;
    const spy = vi
      .spyOn(companionDispatch, "prepareCompanionImageCommand")
      .mockImplementation(async (claimed) => {
        const command = await prepare(claimed);
        prepared += 1;
        if (prepared === 1) {
          firstDeadline = Date.parse(command.deadline);
          vi.setSystemTime(new Date(firstDeadline - 10_000));
        }
        if (prepared === 2) vi.setSystemTime(new Date(firstDeadline + 10_000));
        return command;
      });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // There is a free slot after both jobs prepare, and the first lease is now expired.
      const pulled = await batchPull(3);
      expect(
        new Set(pulled.commands.map((command) => command.jobId)).size,
      ).toBe(pulled.commands.length);
      expect(pulled.commands.map((command) => command.jobId).sort()).toEqual(
        [...jobs].sort(),
      );
      expect(firstDeadline).toBeLessThan(Date.now());
      expect(
        pulled.commands.every(
          (command) => Date.parse(command.deadline) >= Date.now() + 59_000,
        ),
      ).toBe(true);
      const executions = await getDb(ctx.db).select().from(imageProcessingJob);
      for (const command of pulled.commands) {
        expect(
          executions
            .find((execution) => execution.attemptId === command.attemptId)
            ?.leaseUntil?.toISOString(),
        ).toBe(command.deadline);
      }
      const attempts = await getDb(ctx.db)
        .select()
        .from(imageProcessingAttempt);
      expect(attempts).toHaveLength(2);
      expect(new Set(attempts.map((attempt) => attempt.jobId)).size).toBe(2);
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });

  it("rolls back a refused reservation after a successful prefix and takes the next candidate", async () => {
    const owner = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const prefix = await job(
      IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
      "image/jpeg",
      owner,
    );
    const refused = await job(
      IMAGE_DESCRIPTION_PROCESSOR_REVISION,
      "image/avif",
    );
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const reserve = companionDispatch.reserveCompanionAnalysisOutput;
    let reservationSucceeded = false;
    const spy = vi
      .spyOn(companionDispatch, "reserveCompanionAnalysisOutput")
      .mockImplementation(async (tx, command) => {
        const accepted = await reserve(tx, command);
        if (command.jobId === refused) {
          reservationSucceeded = accepted;
          return false;
        }
        return accepted;
      });
    try {
      const device = hello();
      const pulled = await pullCompanionImageProcessing(
        ctx.db,
        {
          hello: {
            ...device,
            capabilities: {
              ...device.capabilities,
              jpegNormalization: { available: true, revision: 1 },
            },
          },
          leaseSeconds: 60,
          maxCommands: 2,
        },
        userId,
      );
      expect(reservationSucceeded).toBe(true);
      expect(pulled.commands.map((command) => command.jobId)).toEqual([
        prefix,
        backfill,
      ]);
      const attempts = await getDb(ctx.db)
        .select()
        .from(imageProcessingAttempt);
      expect(attempts.map((attempt) => attempt.jobId).sort()).toEqual(
        [prefix, backfill].sort(),
      );
      const [released] = await readImageExecutions(ctx.db, refused);
      expect(released?.leaseToken).toBeNull();
      expect(released!.availableAt.getTime()).toBeGreaterThan(Date.now());
      const [row] = await getDb(ctx.db)
        .select()
        .from(imageProcessingJob)
        .where(eq(imageProcessingJob.id, refused));
      expect(row?.attempts).toBe(0);
      const assigned = await getDb(ctx.db)
        .select()
        .from(imageProcessingEvent)
        .where(eq(imageProcessingEvent.jobId, refused));
      expect(
        assigned.some((event) => event.event === "execution.assigned"),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("concurrent batches never hand the same attempt or job to two devices", async () => {
    for (let index = 0; index < 12; index++)
      await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const batches = await Promise.all([batchPull(8), batchPull(8)]);
    const commands = batches.flatMap((batch) => batch.commands);
    expect(batches.map((batch) => batch.commands.length).sort()).toEqual([
      4, 8,
    ]);
    expect(new Set(commands.map((command) => command.jobId)).size).toBe(12);
    expect(new Set(commands.map((command) => command.attemptId)).size).toBe(12);
  });

  it("defaults an old client's pull to one command", async () => {
    await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const pulled = await batchPull();
    expect(pulled.commands).toHaveLength(1);
    expect(pulled.command).toEqual(pulled.commands[0]);
  });

  it("returns prepared commands and releases a later failed hand-off with backoff", async () => {
    const ready = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const unsupported = await job(
      IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
      "image/gif",
    );
    const pulled = await batchPull(2);
    expect(pulled.commands.map((command) => command.jobId)).toEqual([ready]);
    expect(pulled.command).toEqual(pulled.commands[0]);
    const [released] = await readImageExecutions(ctx.db, unsupported);
    expect(released?.leaseToken).toBeNull();
    expect(released!.availableAt.getTime()).toBeGreaterThan(Date.now());
    const attempts = await getDb(ctx.db).select().from(imageProcessingAttempt);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.jobId).toBe(ready);
  });

  it("releases a refused batch hand-off without an attempt", async () => {
    const waiting = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const device = hello();
    await createDevice(
      ctx.db,
      {
        installationId: device.deviceId,
        name: "Synthetic stopped phone",
        platform: "ios",
        appVersion: "1",
        osVersion: "26",
        automaticWork: false,
        remotePaused: false,
      },
      TEST_ACTOR,
    );
    expect(
      await claimCompanionImageCommands(ctx.db, {
        device,
        userId,
        leaseMs: 60_000,
        maxCommands: 8,
      }),
    ).toEqual([]);
    const [execution] = await readImageExecutions(ctx.db, waiting);
    expect(execution?.leaseToken).toBeNull();
    expect(execution?.state).toBe("queued");
    expect(
      await getDb(ctx.db).select().from(imageProcessingAttempt),
    ).toHaveLength(0);
  });

  it("claims parked device work at once but preserves retry backoff", async () => {
    const parked = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const backingOff = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    await updateImageExecution(ctx.db, backingOff, {
      failures: 1,
      runAt: sql`now() + interval '1 hour'`,
    });
    const [execution] = await readImageExecutions(ctx.db, parked).then((rows) =>
      rows.map(({ kind }) => ({ kind })),
    );
    expect(execution?.kind).toBe("device");
    const first = await claim();
    expect(first?.id).toBe(parked);
    // Device expiry uses the requested lease.
    expect(first!.leaseExpiresAt.getTime() - Date.now()).toBeGreaterThan(
      50_000,
    );
    expect(first!.leaseExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      60_000,
    );
    expect(await claim()).toBeNull();
  });

  // Review finding: device pulls ordered parked work only by availability,
  // so an active Run's photos waited behind older backfill.
  it("serves an active Run's device work before older backfill", async () => {
    const backfill = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const owned = await job(
      IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
      "image/jpeg",
      runId,
    );
    expect((await claim())?.id).toBe(owned);
    expect((await claim())?.id).toBe(backfill);
  });

  it("filters processor revision and exclusively claims each device job", async () => {
    const cloud = await job(IMAGE_DESCRIPTION_PROCESSOR_REVISION);
    const apple = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const leases = await Promise.all([claim(), claim()]);
    expect(leases.filter(Boolean).map((lease) => lease?.id)).toEqual([apple]);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(eq(imageProcessingJob.id, cloud));
    expect(saved?.state).toBe("pending");
  });

  it("leases only cloud AVIF work for a normalization-only companion", async () => {
    const jpeg = await job(IMAGE_DESCRIPTION_PROCESSOR_REVISION);
    const apple = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const avif = await job(IMAGE_DESCRIPTION_PROCESSOR_REVISION, "image/avif");
    const lease = await claimImageProcessingJob(ctx.db, {
      kinds: ["describe_image"],
      leaseMs: 60_000,
      processorRevisions: [],
      allowAvifNormalization: true,
    });
    expect(lease?.id).toBe(avif);
    expect(
      await claimImageProcessingJob(ctx.db, {
        kinds: ["describe_image"],
        leaseMs: 60_000,
        processorRevisions: [],
        allowAvifNormalization: true,
      }),
    ).toBeNull();
    const remaining = await getDb(ctx.db)
      .select()
      .from(imageProcessingJob)
      .where(sql`${imageProcessingJob.id} in (${jpeg}, ${apple})`);
    expect(remaining.map((row) => row.state)).toEqual(["pending", "pending"]);
  });

  it("releases without an attempt, prefers another device, and keeps a released attempt's late result out", async () => {
    const jobId = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const first = await claim();
    if (!first) throw new Error("Expected lease");
    await assign(first);
    expect(
      await releaseAssignedImageProcessingJob(ctx.db, {
        jobId: first.id,
        attemptId: first.attemptId,
        userId,
        deviceId: parseEntityId("device", crypto.randomUUID()),
      }),
    ).toBe(false);
    expect(
      await releaseAssignedImageProcessingJob(ctx.db, {
        jobId: first.id,
        attemptId: first.attemptId,
        userId,
        deviceId,
      }),
    ).toBe(true);
    expect(
      await releaseAssignedImageProcessingJob(ctx.db, {
        jobId: first.id,
        attemptId: first.attemptId,
        userId,
        deviceId,
      }),
    ).toBe(false);
    const [execution] = await readImageExecutions(ctx.db, jobId).then((rows) =>
      rows.map(({ attempts, state }) => ({ state, attempts })),
    );
    // Due at once, and the release spent nothing.
    expect(execution).toEqual({ state: "queued", attempts: 0 });

    // Another device's work comes first for the device that let this go.
    const other = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    expect((await claim())?.id).toBe(other);
    const second = await claim();
    expect(second?.id).toBe(jobId);
    expect(second?.attemptId).not.toBe(first.attemptId);
    expect(
      (await completeImageProcessingJob(ctx.db, failure(first))).adopted,
    ).toBe(false);
    const [attempt] = await getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.id, first.attemptId));
    expect(attempt).toMatchObject({
      state: "released",
      error: "Background execution released",
    });
  });

  it("renews a 60 s lease by heartbeat and refuses a lost or obsolete one", async () => {
    const jobId = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const lease = await claim();
    if (!lease) throw new Error("Expected lease");
    await assign(lease);
    const input = { jobId, attemptId: lease.attemptId, deviceId, userId };
    const renewed = await renewAssignedImageProcessingLease(ctx.db, input);
    expect(renewed).toMatchObject({ ok: true });
    if (!renewed.ok) throw new Error("Expected renewal");
    expect(Date.parse(renewed.leaseExpiresAt) - Date.now()).toBeGreaterThan(
      55_000,
    );
    // An expired lease nobody replaced is still this attempt's.
    await expire(jobId);
    expect(
      await renewAssignedImageProcessingLease(ctx.db, input),
    ).toMatchObject({ ok: true });
    // Another device's heartbeat for this attempt is refused.
    expect(
      await renewAssignedImageProcessingLease(ctx.db, {
        ...input,
        deviceId: parseEntityId("device", crypto.randomUUID()),
      }),
    ).toEqual({ ok: false, reason: "lease_lost" });
    await expire(jobId);
    const replacement = await claim(
      parseEntityId("device", crypto.randomUUID()),
    );
    expect(replacement?.id).toBe(jobId);
    expect(await renewAssignedImageProcessingLease(ctx.db, input)).toEqual({
      ok: false,
      reason: "lease_lost",
    });
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "skipped" })
      .where(eq(imageProcessingJob.id, jobId));
    expect(await renewAssignedImageProcessingLease(ctx.db, input)).toEqual({
      ok: false,
      reason: "job_obsolete",
    });
  });

  it("adopts a late result while no newer attempt claimed it, and records one that came after", async () => {
    const jobId = await job(IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION);
    const lease = await claim();
    if (!lease) throw new Error("Expected lease");
    await assign(lease);
    await expire(jobId);
    // Late, but nobody reclaimed it: adopted, and the job backs off.
    expect(
      (await completeImageProcessingJob(ctx.db, failure(lease))).adopted,
    ).toBe(true);
    const [execution] = await readImageExecutions(ctx.db, jobId).then((rows) =>
      rows.map(({ attempts, state }) => ({ state, attempts })),
    );
    expect(execution).toEqual({ state: "retry_wait", attempts: 1 });

    await updateImageExecution(ctx.db, jobId, { runAt: new Date(0) });
    const next = await claim();
    if (!next) throw new Error("Expected retry lease");
    await assign(next);
    await expire(jobId);
    const newest = await claim(parseEntityId("device", crypto.randomUUID()));
    expect(newest?.id).toBe(jobId);
    // A newer attempt owns it: not adopted, but the failure is history.
    expect(
      (await completeImageProcessingJob(ctx.db, failure(next))).adopted,
    ).toBe(false);
    const [attempt] = await getDb(ctx.db)
      .select()
      .from(imageProcessingAttempt)
      .where(eq(imageProcessingAttempt.id, next.attemptId));
    expect(attempt).toMatchObject({
      state: "failed",
      error: "Synthetic late device failure",
    });
    const events = await getDb(ctx.db)
      .select({
        event: imageProcessingEvent.event,
        level: imageProcessingEvent.level,
      })
      .from(imageProcessingEvent)
      .where(eq(imageProcessingEvent.jobId, jobId));
    expect(events).toContainEqual({
      event: "completion.rejected",
      level: "error",
    });
  });
});
