import { activityAttemptInput } from "@cubby/schemas/activity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { runPurpose } from "@cubby/schemas/run-fields";
import { generateShortcode } from "@cubby/shared";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  imageProcessingAttempt,
  imageProcessingEvent,
  imageProcessingJob,
  imageProcessingSubmission,
} from "~/server/db/image-processing-schema";
import {
  aiAnalysis,
  aiUsage,
  auditLog,
  image,
  run as runTable,
  runOperation,
  runProgress,
  runTarget,
  vendor as vendorTable,
} from "~/server/db/schema";
import { ensureRun } from "~/server/runs/ensure-run";

import {
  activityDetail,
  activityDevices,
  activityEvents,
  activitySubmission,
  listActivityGroups,
  listActivityGroupChildren,
  imageAnalysisHistory,
  listActivity,
} from "./activity";
import { getDb } from "./database-helpers";
import { createUploadedImageRecord } from "./image";
import {
  IMAGE_DESCRIPTION_PROCESSOR_REVISION,
  IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
  createImageProcessingJob,
} from "./image-processing";
import { insertEntityAttachments } from "./repo.fixtures";
import { getRunByShortcode } from "./run";
import { insertWithShortcode } from "./shortcode-utils";

describe("activity image processing projection", () => {
  const ctx = withTestDb();

  it("opens browser-carried internal Run identity through the canonical activity read", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const [saved] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, runId));
    if (!saved) throw new Error("Synthetic browser Run unavailable");
    const input = activityAttemptInput.parse({ id: runId });
    const canonical = await activityDetail(ctx.db, null, {
      ...input,
      id: saved.shortcode,
    });
    expect(await activityDetail(ctx.db, null, input)).toEqual(canonical);
    expect(await activityEvents(ctx.db, null, input)).toEqual(
      await activityEvents(ctx.db, null, { ...input, id: saved.shortcode }),
    );
    await expect(
      activityDetail(ctx.db, null, { ...input, id: crypto.randomUUID() }),
    ).rejects.toThrow("Activity run was not found");
  });

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
      .set({ state: "failed", submissionId: submission.id, runId })
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
      runId,
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
    expect(
      allRuns.items.find((row) => row.recordType === "run")?.estimatedCost,
    ).toBeCloseTo(1.16);
    expect(
      allRuns.items.filter((row) => row.recordType === "image_job"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ estimatedCost: 0.46 }),
        expect.objectContaining({ estimatedCost: 0.7 }),
      ]),
    );
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
          entityKind: "image" as const,
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
          entityKind: "image" as const,
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

  it("keeps cross-domain same-time pages stable and includes account sync runs", async () => {
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
    const runPublicId = generateShortcode("run");
    const [run] = await getDb(ctx.db)
      .insert(runTable)
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
      .returning({ id: runTable.id });
    // The real diagnosis, not a placeholder: the feed is the first place an
    // operator looks when a run stalls.
    await getDb(ctx.db).insert(runOperation).values({
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
          kind: "account_sync",
          limit: 20,
          sort: "newest",
          executor: "cloud",
        })
      ).items,
    ).toHaveLength(1);
  });
});

describe("unified Runs history", () => {
  const ctx = withTestDb();

  it("presents Run-scoped research targets in lists, groups, and details", async () => {
    const coordinatorId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const subjectId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    const subjects = await getDb(ctx.db)
      .select({ id: runTable.id, shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, subjectId));
    const coordinators = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, coordinatorId));
    await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: coordinatorId,
        entityKind: "run",
        entityId: subjectId,
        state: "pending",
        targetFingerprint: "a".repeat(64),
      });
    const expected = {
      id: coordinators[0]!.shortcode,
      targetPreview: [
        { entity: "run", id: subjects[0]!.shortcode, state: "pending" },
      ],
    };
    const input = {
      recordType: "run" as const,
      kind: "background" as const,
      executor: "all" as const,
      sort: "newest" as const,
      limit: 20,
    };
    expect(
      (await listActivity(ctx.db, null, input)).items.find(
        (row) => row.id === expected.id,
      ),
    ).toMatchObject(expected);
    expect(
      (await listActivityGroups(ctx.db, null, input)).items.find(
        (group) => group.root.id === expected.id,
      )?.root,
    ).toMatchObject(expected);
    expect(
      (
        await activityDetail(ctx.db, null, {
          id: coordinators[0]!.shortcode,
          limit: 5,
        })
      ).run,
    ).toMatchObject(expected);
  });

  it("lists every Run purpose and keeps linked and standalone image jobs distinct", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "History member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const runs = await getDb(ctx.db)
      .insert(runTable)
      .values(
        runPurpose.options.map((purpose) => ({
          shortcode: generateShortcode("run"),
          ledgerPartyId: party.id,
          actorUserId: ctx.actor.userId,
          actorName: "History member",
          actorEmail: "history@example.test",
          actorLedgerPartyShortcode: party.shortcode,
          actorLedgerPartyName: party.name,
          actorLedgerPartyKind: party.kind,
          purpose,
          trigger: "manual" as const,
          status: "completed" as const,
          startedAt: new Date(),
          endedAt: new Date(),
        })),
      )
      .returning({ id: runTable.id, shortcode: runTable.shortcode });
    const parent = runs[0];
    if (!parent) throw new Error("Expected parent Run");
    const imageRecord = await createUploadedImageRecord(ctx.db, {
      key: `history/${crypto.randomUUID()}.jpg`,
      filename: "history-object.jpg",
      contentType: "image/jpeg",
      size: 100,
    });
    const imageId = parseEntityId("image", imageRecord.id);
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "b".repeat(64) })
      .where(eq(image.id, imageRecord.id));
    const linked = await createImageProcessingJob(ctx.db, {
      imageId,
      kind: "describe_image",
      sourceContentHash: "b".repeat(64),
      processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
      runId: parent.id,
    });
    const standalone = await createImageProcessingJob(ctx.db, {
      imageId,
      kind: "subject_lift",
      sourceContentHash: "b".repeat(64),
      processorRevision: IMAGE_SUBJECT_LIFT_PROCESSOR_REVISION,
    });
    if (!linked || !standalone) throw new Error("Expected image jobs");

    const flat = await listActivity(ctx.db, null, {
      executor: "all",
      limit: 100,
      sort: "newest",
    });
    expect(flat.items.filter((row) => row.recordType === "run")).toHaveLength(
      runPurpose.options.length,
    );
    expect(
      flat.items.find((row) => row.kind === "product_enrichment")?.iconEntity,
    ).toBe("product");
    expect(
      flat.items.find((row) => row.kind === "photo_inventory")?.iconEntity,
    ).toBe("inventory");
    expect(
      flat.items.find((row) => row.kind === "mail_search")?.iconEntity,
    ).toBe("vendorAccount");
    expect(
      flat.items.find((row) => row.kind === "subject_lift")?.iconEntity,
    ).toBe("image");
    expect(flat.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordType: "image_job",
          parentRunId: parent.shortcode,
        }),
        expect.objectContaining({
          recordType: "image_job",
          parentRunId: null,
        }),
      ]),
    );

    const grouped = await listActivityGroups(ctx.db, null, {
      executor: "all",
      limit: 2,
      sort: "newest",
    });
    expect(grouped.total).toBe(runPurpose.options.length + 1);
    expect(grouped.totalItems).toBe(runPurpose.options.length + 2);
    const allGroupIds = new Set(grouped.items.map((item) => item.root.id));
    let nextCursor = grouped.nextCursor;
    while (nextCursor) {
      const next = await listActivityGroups(ctx.db, null, {
        executor: "all",
        limit: 2,
        sort: "newest",
        cursor: nextCursor,
      });
      for (const item of next.items) allGroupIds.add(item.root.id);
      nextCursor = next.nextCursor;
    }
    expect(allGroupIds.size).toBe(grouped.total);
    const parentGroup = await listActivityGroups(ctx.db, null, {
      executor: "all",
      limit: 100,
      sort: "newest",
    });
    expect(
      parentGroup.items.find((item) => item.root.id === parent.shortcode),
    ).toMatchObject({ childCount: 1, contextOnly: false });
    const children = await listActivityGroupChildren(ctx.db, null, {
      rootId: parent.shortcode,
      executor: "all",
      limit: 1,
      sort: "newest",
    });
    expect(children.items).toEqual([
      expect.objectContaining({ parentRunId: parent.shortcode }),
    ]);
    expect(children.nextCursor).toBeNull();
    // Filtering to an image child must count its terminal result, not its context root.
    for (const [state, bucket] of [
      ["ready", "completed"],
      ["skipped", "skipped"],
    ] as const) {
      await getDb(ctx.db)
        .update(imageProcessingJob)
        .set({ state })
        .where(eq(imageProcessingJob.id, linked));
      const terminal = await listActivityGroups(ctx.db, null, {
        executor: "all",
        limit: 10,
        sort: "newest",
        kind: "describe_image",
      });
      expect(terminal.items[0]).toMatchObject({
        contextOnly: true,
        workCounts: { working: 0, waiting: 0, [bucket]: 1 },
      });
    }
    const contextual = await listActivityGroups(ctx.db, null, {
      executor: "all",
      limit: 10,
      sort: "newest",
      kind: "describe_image",
    });
    expect(contextual.items).toEqual([
      expect.objectContaining({
        contextOnly: true,
        childCount: 1,
        root: expect.objectContaining({
          id: parent.shortcode,
          recordType: "run",
        }),
      }),
    ]);
    const standaloneOnly = await listActivity(ctx.db, null, {
      executor: "all",
      limit: 10,
      sort: "newest",
      recordType: "image_job",
      kind: "subject_lift",
    });
    expect(standaloneOnly.items).toEqual([
      expect.objectContaining({ parentRunId: null, recordType: "image_job" }),
    ]);
  });

  // The Runs list hides routine passes by default; a productive or failed
  // scheduled pass and every other Run must stay.
  // Failures: research descendants split into separate roots, an image stops at
  // its immediate research parent, filtered roots vanish, or child paging loses rows.
  it("groups nested research and image work by retained Run lineage with filtered child pagination", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic lineage member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const rootId = await ensureRun(ctx.db, ctx.actor, {
      trigger: "manual",
      status: "completed",
      purpose: "mail_discovery",
    });
    const receiptId = await ensureRun(ctx.db, ctx.actor, {
      trigger: "manual",
      status: "completed",
      purpose: "mail_import",
      parentRunId: rootId,
    });
    const productId = await ensureRun(ctx.db, ctx.actor, {
      trigger: "manual",
      status: "completed",
      purpose: "product_enrichment",
      parentRunId: receiptId,
    });
    const rows = await getDb(ctx.db).select().from(runTable);
    const root = rows.find((row) => row.id === rootId)!;
    const receipt = rows.find((row) => row.id === receiptId)!;
    const productRun = rows.find((row) => row.id === productId)!;
    const uploaded = await createUploadedImageRecord(ctx.db, {
      key: `lineage/${crypto.randomUUID()}.jpg`,
      filename: "synthetic-lineage.jpg",
      contentType: "image/jpeg",
      size: 100,
    });
    await getDb(ctx.db)
      .update(image)
      .set({ sha256: "c".repeat(64) })
      .where(eq(image.id, uploaded.id));
    const job = await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", uploaded.id),
      kind: "describe_image",
      sourceContentHash: "c".repeat(64),
      processorRevision: IMAGE_DESCRIPTION_PROCESSOR_REVISION,
      runId: productId,
    });
    if (!job) throw new Error("Expected lineage image job");
    const input = {
      executor: "all" as const,
      limit: 100,
      sort: "newest" as const,
    };
    const groups = await listActivityGroups(ctx.db, null, input);
    expect(groups).toMatchObject({
      total: 1,
      totalItems: 4,
      items: [
        { root: { id: root.shortcode }, childCount: 3, contextOnly: false },
      ],
    });
    const filtered = await listActivityGroups(ctx.db, null, {
      ...input,
      kind: "product_enrichment",
    });
    expect(filtered).toMatchObject({
      total: 1,
      totalItems: 1,
      items: [
        { root: { id: root.shortcode }, childCount: 1, contextOnly: true },
      ],
    });
    const childIds = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await listActivityGroupChildren(ctx.db, null, {
        ...input,
        rootId: root.shortcode,
        limit: 1,
        cursor,
      });
      expect(page.total).toBe(3);
      for (const child of page.items) childIds.add(child.id);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(childIds.size).toBe(3);
    expect(childIds.has(receipt.shortcode)).toBe(true);
    expect(childIds.has(productRun.shortcode)).toBe(true);
    const products = await listActivityGroupChildren(ctx.db, null, {
      ...input,
      rootId: root.shortcode,
      kind: "product_enrichment",
    });
    expect(products.items.map((row) => row.id)).toEqual([productRun.shortcode]);
  });

  // A tombstoned ancestor must not hide live work; null legacy lineage stays independent.
  it("keeps legacy roots and research below a deleted parent visible without inventing lineage", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic legacy member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const deletedId = await ensureRun(ctx.db, ctx.actor, {
      trigger: "manual",
      status: "completed",
      purpose: "mail_discovery",
    });
    const childId = await ensureRun(ctx.db, ctx.actor, {
      trigger: "manual",
      status: "completed",
      purpose: "mail_import",
      parentRunId: deletedId,
    });
    const grandchildId = await ensureRun(ctx.db, ctx.actor, {
      trigger: "manual",
      status: "completed",
      purpose: "product_enrichment",
      parentRunId: childId,
    });
    const legacyId = await ensureRun(ctx.db, ctx.actor, {
      trigger: "manual",
      status: "completed",
      purpose: "mail_import",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ deletedAt: new Date() })
      .where(eq(runTable.id, deletedId));
    const rows = await getDb(ctx.db).select().from(runTable);
    const child = rows.find((row) => row.id === childId)!;
    const legacy = rows.find((row) => row.id === legacyId)!;
    const input = {
      executor: "all" as const,
      limit: 100,
      sort: "newest" as const,
    };
    const groups = await listActivityGroups(ctx.db, null, input);
    expect(groups.total).toBe(2);
    expect(groups.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          root: expect.objectContaining({ id: child.shortcode }),
          childCount: 1,
        }),
        expect.objectContaining({
          root: expect.objectContaining({ id: legacy.shortcode }),
          childCount: 0,
        }),
      ]),
    );
    const children = await listActivityGroupChildren(ctx.db, null, {
      ...input,
      rootId: child.shortcode,
    });
    expect(children.items.map((row) => row.id)).toEqual([
      rows.find((row) => row.id === grandchildId)!.shortcode,
    ]);
    expect(rows.find((row) => row.id === legacyId)?.parentRunId).toBeNull();
  });

  it("counts matching work across every group independently of cursor pagination", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic overview member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const rootId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "completed",
    });
    await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_import",
      trigger: "discovery",
      parentRunId: rootId,
    });
    const waitingId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "product_enrichment",
      trigger: "manual",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "paused_offline" })
      .where(eq(runTable.id, waitingId));
    const input = {
      executor: "all" as const,
      sort: "newest" as const,
      limit: 1,
    };
    const counts = {
      working: 1,
      waiting: 1,
      needsReview: 0,
      failed: 0,
      completed: 1,
      skipped: 0,
    };
    expect.soft(await listActivity(ctx.db, null, input)).toMatchObject({
      total: 3,
      workCounts: counts,
    });
    const first = await listActivityGroups(ctx.db, null, input);
    expect(first).toMatchObject({
      total: 2,
      totalItems: 3,
      workCounts: counts,
    });
    expect(first.items).toHaveLength(1);
    if (!first.nextCursor)
      throw new Error("Synthetic overview did not paginate");
    expect(
      await listActivityGroups(ctx.db, null, {
        ...input,
        cursor: first.nextCursor,
      }),
    ).toMatchObject({ total: 2, totalItems: 3, workCounts: counts });
    expect(
      await listActivityGroups(ctx.db, null, {
        ...input,
        state: "paused_offline",
      }),
    ).toMatchObject({
      total: 1,
      totalItems: 1,
      workCounts: { ...counts, working: 0, completed: 0 },
    });
    expect(
      await listActivityGroups(ctx.db, null, {
        ...input,
        state: "dispatch_failed",
      }),
    ).toMatchObject({
      total: 0,
      totalItems: 0,
      workCounts: { ...counts, working: 0, waiting: 0, completed: 0 },
    });
  });

  it("keeps completed research roots refreshable while a descendant is running", async () => {
    await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic active lineage member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const rootId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_discovery",
      trigger: "manual",
      status: "completed",
    });
    const childId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "mail_import",
      trigger: "discovery",
      parentRunId: rootId,
    });
    const input = {
      executor: "all" as const,
      limit: 100,
      sort: "newest" as const,
    };
    expect((await listActivityGroups(ctx.db, null, input)).items).toMatchObject(
      [
        {
          active: true,
          root: { active: false, state: "completed" },
          workCounts: {
            working: 1,
            waiting: 0,
            needsReview: 0,
            failed: 0,
            completed: 1,
          },
        },
      ],
    );
    for (const [status, bucket] of [
      ["paused_auth", "waiting"],
      ["needs_review", "needsReview"],
      ["failed", "failed"],
    ] as const) {
      await getDb(ctx.db)
        .update(runTable)
        .set({ status })
        .where(eq(runTable.id, childId));
      const group = (await listActivityGroups(ctx.db, null, input)).items[0];
      expect(group).toMatchObject({
        workCounts: { working: 0, [bucket]: 1, completed: 1 },
      });
    }
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(runTable.id, childId));
    expect((await listActivityGroups(ctx.db, null, input)).items).toMatchObject(
      [
        {
          active: false,
          root: { active: false, state: "completed" },
          workCounts: {
            working: 0,
            waiting: 0,
            needsReview: 0,
            failed: 0,
            completed: 2,
          },
        },
      ],
    );
  });

  it("does not evaluate unrelated Run accounting when paging one research group", async () => {
    const rootId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
    });
    await ensureRun(ctx.db, ctx.actor, {
      purpose: "background",
      parentRunId: rootId,
    });
    for (let index = 0; index < 100; index += 1)
      await ensureRun(ctx.db, ctx.actor, { purpose: "background" });
    const [root] = await getDb(ctx.db)
      .select()
      .from(runTable)
      .where(eq(runTable.id, rootId));
    if (!root) throw new Error("Expected synthetic accounting root");
    const execute = vi.spyOn(getDb(ctx.db), "execute");
    await listActivityGroupChildren(ctx.db, null, {
      rootId: root.shortcode,
      executor: "all",
      limit: 1,
      sort: "newest",
    });
    const statement = execute.mock.calls[0]?.[0];
    execute.mockRestore();
    if (!statement) throw new Error("Expected real child page query");
    const explained = await getDb(ctx.db).execute(
      sql`EXPLAIN (ANALYZE, FORMAT JSON) ${statement}`,
    );
    const plan = z
      .array(z.object({ Plan: z.unknown() }))
      .parse(explained.rows[0]?.["QUERY PLAN"])[0]!.Plan;
    const subplanLoops = (raw: unknown): number => {
      const node = z
        .object({
          "Actual Loops": z.number(),
          "Parent Relationship": z.string().optional(),
          Plans: z.array(z.unknown()).optional(),
        })
        .parse(raw);
      return Math.max(
        node["Parent Relationship"] === "SubPlan" ? node["Actual Loops"] : 0,
        ...(node.Plans ?? []).map(subplanLoops),
      );
    };
    expect(subplanLoops(plan)).toBeLessThanOrEqual(2);
  });

  it("says what a run is doing and which records it worked on", async () => {
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Seed fixture vendor",
    });
    const logo = await createUploadedImageRecord(ctx.db, {
      key: `activity/logo-${crypto.randomUUID()}.png`,
      filename: "logo.png",
      contentType: "image/png",
      size: 128,
    });
    await insertEntityAttachments(ctx.db, {
      entityId: vendor.id,
      imageId: logo.id,
      role: "logo",
    });
    const enriched = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture Nasturtium",
      manufacturer: "Fixture Seeds",
    });
    const skipped = await insertWithShortcode(ctx.db, "product", {
      name: "Fixture Tomato",
      manufacturer: "Fixture Seeds",
    });
    const cover = await createUploadedImageRecord(ctx.db, {
      key: `activity/cover-${crypto.randomUUID()}.jpg`,
      filename: "cover.jpg",
      contentType: "image/jpeg",
      size: 128,
    });
    await insertEntityAttachments(ctx.db, {
      entityId: enriched.id,
      imageId: cover.id,
      sortOrder: 0,
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Enrichment member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const shortcode = generateShortcode("run");
    const [run] = await getDb(ctx.db)
      .insert(runTable)
      .values({
        shortcode,
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Enrichment member",
        actorEmail: "enrichment@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: party.kind,
        purpose: "product_enrichment",
        trigger: "scheduled",
        status: "running",
        vendorId: vendor.id,
        startedAt: new Date(),
      })
      .returning({ id: runTable.id });
    await getDb(ctx.db)
      .insert(runTarget)
      .values([
        {
          runId: run!.id,
          entityKind: "product",
          entityId: enriched.id,
          position: 0,
          state: "completed",
          outcome: "enriched",
          targetFingerprint: "1".repeat(64),
        },
        {
          runId: run!.id,
          entityKind: "product",
          entityId: skipped.id,
          position: 1,
          state: "skipped",
          outcome: "skipped",
          warning: "The page lists several variants",
          targetFingerprint: "2".repeat(64),
        },
      ]);
    await getDb(ctx.db)
      .insert(runProgress)
      .values([
        {
          runId: run!.id,
          eventId: crypto.randomUUID(),
          phase: "browsing",
          detail: "Opening the first product page",
          createdAt: new Date(Date.now() - 60_000),
        },
        {
          runId: run!.id,
          eventId: crypto.randomUUID(),
          phase: "reading",
          detail: "Reading Fixture Tomato",
        },
      ]);
    await getDb(ctx.db)
      .insert(auditLog)
      .values([
        {
          runId: run!.id,
          entityKind: "product",
          entityId: enriched.id,
          action: "update",
          changes: { gtin: { from: null, to: "00012345678905" } },
          userId: ctx.actor.userId,
          channel: "system",
        },
        {
          runId: run!.id,
          entityKind: "product",
          entityId: enriched.id,
          action: "update",
          changes: { brand: { from: null, to: "Fixture Seeds" } },
          userId: ctx.actor.userId,
          channel: "system",
        },
      ]);

    const expected = {
      id: shortcode,
      iconEntity: "vendor",
      workLabel: "Product enrichment",
      subjectId: vendor.shortcode,
      subjectImage: { url: expect.stringContaining(logo.key) },
      currentStep: "Reading Fixture Tomato",
      targetCounts: {
        total: 2,
        completed: 1,
        skipped: 1,
        blocked: 0,
        pending: 0,
      },
      targetSummary: "1/2 done · 1 skipped",
      targetPreview: [
        {
          entity: "product",
          id: enriched.shortcode,
          name: "Fixture Nasturtium",
          state: "completed",
          displayImage: { url: expect.stringContaining(cover.key) },
        },
        {
          entity: "product",
          id: skipped.shortcode,
          name: "Fixture Tomato",
          state: "skipped",
          displayImage: null,
        },
      ],
      changedCount: 1,
    };
    const list = await listActivity(ctx.db, null, {
      recordType: "run",
      kind: "product_enrichment",
      executor: "all",
      limit: 20,
      sort: "newest",
    });
    expect(list.items.find((row) => row.id === shortcode)).toMatchObject(
      expected,
    );
    expect(await getRunByShortcode(ctx.db, shortcode)).toMatchObject({
      iconEntity: expected.iconEntity,
    });
    const groups = await listActivityGroups(ctx.db, null, {
      recordType: "run",
      kind: "product_enrichment",
      executor: "all",
      limit: 20,
      sort: "newest",
    });
    expect(
      groups.items.find((group) => group.root.id === shortcode)?.root,
    ).toMatchObject(expected);
    expect(
      (await activityDetail(ctx.db, null, { id: shortcode, limit: 5 })).run,
    ).toMatchObject(expected);
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ deletedAt: new Date() })
      .where(eq(vendorTable.id, vendor.id));
    expect((await getRunByShortcode(ctx.db, shortcode))?.iconEntity).toBe(
      "vendor",
    );
    expect(
      (await activityDetail(ctx.db, null, { id: shortcode, limit: 5 })).run
        .iconEntity,
    ).toBe("vendor");
  });

  // The row names the targets the run works first: tied positions fall back
  // to creation order, as the run itself does, never to the random row id.
  it("previews targets in the order the run works them", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Order member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const shortcode = generateShortcode("run");
    const [run] = await getDb(ctx.db)
      .insert(runTable)
      .values({
        shortcode,
        ledgerPartyId: party.id,
        actorUserId: ctx.actor.userId,
        actorName: "Order member",
        actorEmail: "order@example.test",
        actorLedgerPartyShortcode: party.shortcode,
        actorLedgerPartyName: party.name,
        actorLedgerPartyKind: party.kind,
        purpose: "product_enrichment",
        trigger: "manual",
        status: "running",
        startedAt: new Date(),
      })
      .returning({ id: runTable.id });
    const products = [];
    for (const index of [0, 1, 2, 3])
      products.push(
        await insertWithShortcode(ctx.db, "product", {
          name: `Order fixture ${index}`,
          manufacturer: "Fixture Seeds",
        }),
      );
    // Ids descend while creation ascends, so an id tiebreak would reverse them.
    await getDb(ctx.db)
      .insert(runTarget)
      .values(
        products.map((product, index) => ({
          id: `0000000${9 - index}-0000-4000-8000-000000000000`,
          runId: run!.id,
          entityKind: "product" as const,
          entityId: product.id,
          position: 0,
          targetFingerprint: String(index).repeat(64),
          createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)),
        })),
      );

    const list = await listActivity(ctx.db, null, {
      recordType: "run",
      executor: "all",
      limit: 50,
      sort: "newest",
    });
    expect(
      list.items
        .find((row) => row.id === shortcode)
        ?.targetPreview.map((target) => target.name),
    ).toEqual(["Order fixture 0", "Order fixture 1", "Order fixture 2"]);
  });

  it("filters routine runs either way only when asked", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Routine member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const scheduled = (routine: boolean, status: "completed" | "failed") => ({
      shortcode: generateShortcode("run"),
      ledgerPartyId: party.id,
      actorUserId: ctx.actor.userId,
      actorName: "Routine member",
      actorEmail: "routine@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: party.kind,
      purpose: "mail_discovery" as const,
      trigger: "scheduled" as const,
      status,
      routine,
      startedAt: new Date(),
      endedAt: new Date(),
    });
    const [quiet, productive, failed] = await getDb(ctx.db)
      .insert(runTable)
      .values([
        scheduled(true, "completed"),
        scheduled(false, "completed"),
        scheduled(false, "failed"),
      ])
      .returning({ shortcode: runTable.shortcode });
    const shown = async (routine?: boolean) =>
      (
        await listActivity(ctx.db, null, {
          executor: "all",
          limit: 100,
          sort: "newest",
          routine,
        })
      ).items.map((row) => row.id);

    expect(await shown()).toEqual(
      expect.arrayContaining([quiet?.shortcode, productive?.shortcode]),
    );
    const filtered = await shown(false);
    expect(filtered).not.toContain(quiet?.shortcode);
    expect(filtered).toEqual(
      expect.arrayContaining([productive?.shortcode, failed?.shortcode]),
    );
    expect(await shown(true)).toEqual([quiet?.shortcode]);
  });
});
