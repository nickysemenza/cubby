import { parseEntityId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import {
  imageProcessingAttempt,
  imageProcessingEvent,
  imageProcessingJob,
  imageProcessingSubmission,
} from "~/server/db/image-processing-schema";
import {
  aiAnalysis,
  aiUsage,
  image,
  importRun,
  importRunOperation,
} from "~/server/db/schema";
import { ensureRun } from "~/server/runs/ensure-run";

import {
  activityDevices,
  activityEvents,
  activitySubmission,
  imageAnalysisHistory,
  listActivity,
} from "./activity";
import { getDb } from "./database-helpers";
import { createUploadedImageRecord } from "./image";
import {
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  createImageProcessingJob,
} from "./image-processing";
import { insertWithShortcode } from "./shortcode-utils";

describe("activity image processing projection", () => {
  const ctx = withTestDb();

  it("keeps submission cost on its exact attempts and filters actual device execution", async () => {
    const uploaded = await createUploadedImageRecord(ctx.db, {
      key: `activity/${crypto.randomUUID()}.jpg`,
      filename: "activity-object.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const sourceHash = "a".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: sourceHash })
      .where(eq(image.id, uploaded.id));
    const imageId = parseEntityId("image", uploaded.id);
    const jobId = await createImageProcessingJob(ctx.db, {
      imageId,
      kind: "subject_lift",
      sourceContentHash: sourceHash,
      processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
    });
    if (!jobId) throw new Error("Expected image processing job");
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const [submission, laterSubmission] = await getDb(ctx.db)
      .insert(imageProcessingSubmission)
      .values([{}, {}])
      .returning();
    if (!submission || !laterSubmission)
      throw new Error("Expected image processing submissions");

    const firstAttempt = crypto.randomUUID();
    const laterAttempt = crypto.randomUUID();
    const deviceId = crypto.randomUUID();
    await getDb(ctx.db)
      .insert(imageProcessingAttempt)
      .values([
        {
          id: firstAttempt,
          jobId,
          number: 1,
          submissionId: submission.id,
          state: "ready",
          executor: {
            kind: "device",
            deviceId,
            name: "Test Mac",
            platform: "macos",
            appVersion: "1.0",
            osVersion: "26.0",
          },
        },
        {
          id: laterAttempt,
          jobId,
          number: 2,
          submissionId: laterSubmission.id,
          state: "ready",
          startedAt: new Date(Date.now() + 1_000),
          executor: {
            kind: "device",
            deviceId,
            name: "Renamed test Mac",
            platform: "macos",
            appVersion: "2.0",
            osVersion: "26.1",
          },
        },
      ]);
    await getDb(ctx.db)
      .insert(aiUsage)
      .values([
        {
          feature: "image-description",
          provider: "test",
          model: "test-model",
          operation: "imageDescription",
          runId,
          jobKind: "image_processing_attempt",
          jobId: firstAttempt,
          estimatedCost: 0.12,
          durationMs: 1,
        },
        {
          feature: "image-description",
          provider: "test",
          model: "test-model",
          operation: "imageDescription",
          runId,
          jobKind: "image_processing_attempt",
          jobId: laterAttempt,
          estimatedCost: 0.34,
          durationMs: 1,
        },
      ]);
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "failed", submissionId: submission.id })
      .where(eq(imageProcessingJob.id, jobId));

    const deviceRuns = await listActivity(ctx.db, null, {
      executor: "device",
      limit: 20,
      sort: "newest",
    });
    expect(deviceRuns.items).toHaveLength(1);
    // Software upgrades and renames never duplicate the device picker entry.
    expect((await activityDevices(ctx.db, null)).items).toMatchObject([
      { deviceId, name: "Renamed test Mac" },
    ]);
    expect(deviceRuns.items[0]).toMatchObject({
      id: expect.stringMatching(/^IPR-/u),
      canRetry: true,
      estimatedCost: 0.46,
    });

    const summary = await activitySubmission(ctx.db, submission.publicId);
    expect(summary.estimatedCost).toBe(0.12);

    // A historical job-level call and a later attempt are distinct spend.
    const legacyJob = await createImageProcessingJob(ctx.db, {
      imageId,
      kind: "describe_image",
      sourceContentHash: sourceHash,
      processorRevision: 99_991,
    });
    if (!legacyJob) throw new Error("Expected legacy image job");
    const legacyRetryAttempt = crypto.randomUUID();
    await getDb(ctx.db).insert(imageProcessingAttempt).values({
      id: legacyRetryAttempt,
      jobId: legacyJob,
      number: 1,
      state: "ready",
    });
    await getDb(ctx.db)
      .insert(aiUsage)
      .values([
        {
          feature: "image-description",
          provider: "legacy",
          model: "legacy-model",
          operation: "imageDescription",
          runId,
          jobKind: "describe_image",
          jobId: legacyJob,
          estimatedCost: 0.5,
          durationMs: 1,
        },
        {
          feature: "image-description",
          provider: "cloud",
          model: "retry-model",
          operation: "imageDescription",
          runId,
          jobKind: "image_processing_attempt",
          jobId: legacyRetryAttempt,
          estimatedCost: 0.2,
          durationMs: 1,
        },
      ]);
    const allRuns = await listActivity(ctx.db, null, {
      executor: "all",
      limit: 20,
      sort: "newest",
    });
    expect(
      allRuns.items.find((run) => run.estimatedCost === 0.7),
    ).toBeDefined();
    expect(deviceRuns.items[0]?.estimatedCost).toBe(0.46);

    // This exceeds the detail page's first window. Keyset cursors must keep
    // event pages complete even when a long-running import emits many events.
    await getDb(ctx.db)
      .insert(imageProcessingEvent)
      .values(
        Array.from({ length: 2_001 }, (_, index) => ({
          jobId,
          eventKey: `activity-page-${index}`,
          event: "attempt.progress",
          source: "server",
          details: { index },
        })),
      );
    const events = await activityEvents(ctx.db, null, {
      id: deviceRuns.items[0]!.id,
      limit: 100,
    });
    expect(events.items).toHaveLength(100);
    expect(events.nextCursor).toEqual(expect.any(String));
    const secondEvents = await activityEvents(ctx.db, null, {
      id: deviceRuns.items[0]!.id,
      cursor: events.nextCursor!,
      limit: 100,
    });
    expect(secondEvents.items).toHaveLength(100);
    expect(
      new Set([...events.items, ...secondEvents.items].map((event) => event.id))
        .size,
    ).toBe(200);

    const base = Date.now();
    await getDb(ctx.db)
      .insert(aiAnalysis)
      .values([
        ...Array.from({ length: 25 }, (_, index) => ({
          entityType: "image" as const,
          entityId: imageId,
          feature: "image-description",
          provider: "apple",
          model: `history-model-${index}`,
          promptVersion: "1",
          resultSchemaRevision: 1,
          inputFingerprint: JSON.stringify({ history: index }),
          result: {
            description: `Historical description ${index}`,
            claims: [],
            cutoutEligibility: "ineligible",
          },
          createdAt: new Date(base + index),
        })),
        {
          entityType: "image" as const,
          entityId: imageId,
          feature: "image-description",
          provider: "legacy",
          model: "invalid-history",
          promptVersion: "legacy",
          inputFingerprint: JSON.stringify({ history: "invalid" }),
          result: { unexpected: true },
          createdAt: new Date(base + 26),
        },
      ]);
    const firstHistory = await imageAnalysisHistory(ctx.db, {
      id: uploaded.shortcode,
      limit: 20,
    });
    expect(firstHistory.total).toBe(26);
    expect(firstHistory.items.length + firstHistory.unparsed.length).toBe(20);
    expect(firstHistory.unparsed).toHaveLength(1);
    expect(firstHistory.nextCursor).toEqual(expect.any(String));
    const secondHistory = await imageAnalysisHistory(ctx.db, {
      id: uploaded.shortcode,
      cursor: firstHistory.nextCursor!,
      limit: 20,
    });
    expect(secondHistory.items.length + secondHistory.unparsed.length).toBe(6);
  });

  it("keeps cross-domain same-time pages stable and scopes purchase runs to the member", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Activity member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const uploaded = await createUploadedImageRecord(ctx.db, {
      key: `activity/cross-domain-${crypto.randomUUID()}.jpg`,
      filename: "cross-domain.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    const sourceHash = "b".repeat(64);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: sourceHash })
      .where(eq(image.id, uploaded.id));
    const imageJob = await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", uploaded.id),
      kind: "subject_lift",
      sourceContentHash: sourceHash,
      processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
    });
    if (!imageJob) throw new Error("Expected cross-domain image job");
    const at = new Date("2026-09-20T12:00:00.000Z");
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ createdAt: at })
      .where(eq(imageProcessingJob.id, imageJob));
    const runPublicId = generateShortcode("importRun");
    const [run] = await getDb(ctx.db)
      .insert(importRun)
      .values({
        shortcode: runPublicId,
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Activity member",
        actorEmail: "activity@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: party.kind,
        purpose: "account_sync",
        trigger: "manual",
        status: "completed",
        startedAt: at,
        endedAt: at,
      })
      .returning({ id: importRun.id });
    // The real diagnosis, not a placeholder: the feed is the first place an
    // operator looks when a run stalls.
    await getDb(ctx.db).insert(importRunOperation).values({
      runId: run!.id,
      operationId: "browser-import-orders-1",
      kind: "import_order_evidence",
      inputFingerprint: "fp",
      state: "failed",
      error: "Browser evidence is not complete",
    });
    const runEvents = await activityEvents(ctx.db, party.id, {
      id: runPublicId,
      limit: 10,
    });
    expect(runEvents.items[0]).toMatchObject({
      event: "operation.import_order_evidence",
      level: "error",
    });
    expect(JSON.parse(runEvents.items[0]!.detailsJson!)).toMatchObject({
      error: "Browser evidence is not complete",
    });

    const first = await listActivity(ctx.db, party.id, {
      limit: 1,
      sort: "newest",
      executor: "all",
    });
    expect(first.total).toBe(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await listActivity(ctx.db, party.id, {
      limit: 1,
      sort: "newest",
      cursor: first.nextCursor!,
      executor: "all",
    });
    expect(second.total).toBe(2);
    expect(
      new Set([...first.items, ...second.items].map((run) => run.id)).size,
    ).toBe(2);
    expect(
      (
        await listActivity(ctx.db, party.id, {
          kind: "purchase_import",
          limit: 20,
          sort: "newest",
          executor: "cloud",
        })
      ).items,
    ).toHaveLength(1);
  });
});
