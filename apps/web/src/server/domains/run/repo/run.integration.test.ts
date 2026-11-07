import type { RunId } from "@cubby/schemas/identifiers";
import { parseShortcodeFor } from "@cubby/shared";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  run as runTable,
} from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { readRecordWorkQueue } from "~/server/domains/work/service/work-queue-read";
import { updateJobs } from "~/server/generic/jobs/jobs.fixtures";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import type { ShortcodeGeneratorPort } from "~/server/generic/shortcode/repo/shortcode-utils";

import { readRun, runScaffold } from "./run";

const collisionGenerator = (
  first: string,
  second: string,
): ShortcodeGeneratorPort => {
  const codes = [first, second];
  return {
    generate: (entity) => parseShortcodeFor(entity, codes.shift() ?? second),
  };
};

describe("readRun", () => {
  const ctx = withTestDb();

  // Regression: an AI run has no member party, so its party name reads null.
  // The Run output once declared that name non-null, and the Run detail page
  // failed validation for exactly the runs it was built to show.
  it("reads an AI run that has no member party", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const [row] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, runId));

    const run = await readRun(ctx.db, row!.shortcode);

    expect(run).toMatchObject({
      purpose: "ai_suggest",
      ledgerPartyId: null,
      ledgerPartyName: null,
    });
  });
});

describe("ensureRun shortcode collisions", () => {
  const ctx = withTestDb();

  it("retries a used code for an unkeyed AI run", async () => {
    const existingId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    const [existing] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, existingId));
    const next = "RUN-YYYY";
    const id = await ensureRun(
      ctx.db,
      ctx.actor,
      { purpose: "ai_suggest" },
      collisionGenerator(existing!.shortcode, next),
    );
    const [created] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, id));
    expect(created?.shortcode).toBe(next);
  });

  it("retries a used code and reuses the same client-keyed run", async () => {
    const existingId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
    });
    const [existing] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, existingId));
    const key = "test:shared-suggestion-run";
    const next = "RUN-ZZZZ";
    const createdId = await ensureRun(
      ctx.db,
      ctx.actor,
      { purpose: "ai_suggest", clientKey: key },
      collisionGenerator(existing!.shortcode, next),
    );
    expect(
      await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        clientKey: key,
      }),
    ).toBe(createdId);
    const [created] = await getDb(ctx.db)
      .select({ shortcode: runTable.shortcode })
      .from(runTable)
      .where(eq(runTable.id, createdId));
    expect(created?.shortcode).toBe(next);
  });
});

describe("listRuns", () => {
  const ctx = withTestDb();

  // Automatic usage groups stay stored but do not crowd member session lists.
  it("hides automatic AI Runs until their purpose is explicitly selected", async () => {
    await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    const page = { pageIndex: 0, pageSize: 50 };

    const all = await runScaffold.read(ctx.db, {
      filters: {},
      sorts: [],
      pagination: page,
    });
    const ephemeral = await runScaffold.read(ctx.db, {
      filters: { purpose: ["ai_suggest"], trigger: ["ephemeral"] },
      sorts: [],
      pagination: page,
    });
    const manual = await runScaffold.read(ctx.db, {
      filters: { trigger: ["manual"] },
      sorts: [],
      pagination: page,
    });

    expect(all.data).toEqual([]);
    expect(all.count).toBe(0);
    expect(ephemeral.data).toHaveLength(1);
    expect(manual.data).toHaveLength(0);
  });
});

// A review stop whose open work moved to a retry kept reading "Needs
// review", and funding stops read as review or authorization.
describe("Run lineage and waiting-on reads", () => {
  const ctx = withTestDb();
  const codeOf = async (id: RunId) =>
    (
      await getDb(ctx.db)
        .select({ shortcode: runTable.shortcode })
        .from(runTable)
        .where(eq(runTable.id, id))
    )[0]!.shortcode;

  it("links a retry both ways and reads the predecessor as retried", async () => {
    const earlier = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    const later = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "needs_review" })
      .where(eq(runTable.id, earlier));
    await getDb(ctx.db)
      .update(runTable)
      .set({ predecessorRunId: earlier })
      .where(eq(runTable.id, later));
    const earlierCode = await codeOf(earlier);
    const laterCode = await codeOf(later);

    const predecessor = await readRun(ctx.db, earlierCode);
    const successor = await readRun(ctx.db, laterCode);

    expect(predecessor).toMatchObject({
      status: "needs_review",
      displayStatus: "retried",
      successorRunId: laterCode,
    });
    expect(successor).toMatchObject({
      predecessorRunId: earlierCode,
      successorRunId: null,
    });
  });

  it("reads a funding stop as waiting for funding and rolls up live Jobs", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
    });
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "needs_review", failureCode: "execution_limit" })
      .where(eq(runTable.id, runId));
    for (let index = 0; index < 2; index++)
      await enqueueJob(ctx.db, {
        key: `synthetic.rollup.${index}`,
        kind: "synthetic.rollup",
        input: {},
        runId,
      });

    const read = await readRun(ctx.db, await codeOf(runId));

    expect(read).toMatchObject({
      displayStatus: "waiting_for_funding",
      waitingOn: "2 due",
      stalled: false,
    });
  });

  // Review finding: summaries formatted only `counts`, so a Run whose only
  // Job's executor lease lapsed read as having no live Jobs.
  it("summarizes expired leases awaiting reclaim", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const abandoned = await enqueueJob(ctx.db, {
      key: "synthetic.rollup.abandoned",
      kind: "synthetic.rollup",
      input: {},
      runId,
    });
    await updateJobs(
      ctx.db,
      { id: abandoned.id },
      {
        state: "running",
        leaseToken: crypto.randomUUID(),
        leaseExpiresAt: new Date(Date.now() - 60_000),
        lastClaimedAt: new Date(Date.now() - 5 * 60_000),
      },
    );

    const read = await readRun(ctx.db, await codeOf(runId));

    expect(read?.waitingOn).toBe("1 expired lease awaiting reclaim");
  });
});

describe("Run attention entity view", () => {
  const ctx = withTestDb();
  // Recovery must preserve paid answers and uncertain history while settled work leaves Needs you.
  it("projects historical AI recovery from effective owned and requested work without changing history", async () => {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "scheduled",
      execution: false,
    });
    const [history] = await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed", failureCode: "ai_work_failed" })
      .where(eq(runTable.id, runId))
      .returning();
    if (!history) throw new Error("Missing synthetic Run");
    const visible = async (wanted: boolean) => {
      const page = await runScaffold.read(ctx.db, {
        filters: { purpose: ["ai_refresh"], needsAttention: true },
        sorts: [],
        pagination: { pageIndex: 0, pageSize: 10 },
      });
      expect(page.data.some((row) => row.id === history.shortcode)).toBe(
        wanted,
      );
      const work = await readRecordWorkQueue(ctx.db, {
        id: history.shortcode,
        memberPartyId: null,
        memberOnly: false,
      });
      expect(work.items.some((row) => row.family === "account")).toBe(wanted);
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(runTable)
            .where(eq(runTable.id, runId))
        )[0],
      ).toEqual(history);
    };
    await visible(true); // No durable owned roster.
    const [item] = await getDb(ctx.db)
      .insert(aiEvaluation)
      .values({
        runId,
        executionKind: "ai_refresh",
        feature: "synthetic-attention",
        workKey: crypto.randomUUID(),
        target: {
          kind: "connection",
          entity: "email",
          recordId: crypto.randomUUID(),
          field: null,
          suggestionIds: [],
        },
        provenance: {
          dependencies: [],
          inputFingerprint: "synthetic",
          optionFingerprint: "synthetic",
          model: null,
        },
        snapshot: {},
        state: "failed",
        result: { syntheticPaidAnswer: true },
      })
      .returning();
    if (!item) throw new Error("Missing synthetic evaluation");
    await visible(true);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "result_ready" })
      .where(eq(aiEvaluation.id, item.id));
    await visible(true);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "blocked" })
      .where(eq(aiEvaluation.id, item.id));
    await visible(false);
    for (const receipt of [
      { retryEvaluationId: "malformed" },
      { retryEvaluationId: crypto.randomUUID() },
      { retryEvaluationId: item.id },
    ]) {
      await getDb(ctx.db)
        .update(aiEvaluation)
        .set({ receipt })
        .where(eq(aiEvaluation.id, item.id));
      await visible(true);
    }
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ receipt: null, state: "obsolete" })
      .where(eq(aiEvaluation.id, item.id));
    const [replacement] = await getDb(ctx.db)
      .insert(aiEvaluation)
      .values({
        ...item,
        id: crypto.randomUUID(),
        workKey: crypto.randomUUID(),
        state: "completed",
        receipt: null,
      })
      .returning();
    if (!replacement) throw new Error("Missing synthetic replacement");
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ receipt: { retryEvaluationId: replacement.id }, state: "failed" })
      .where(eq(aiEvaluation.id, item.id));
    await visible(false);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "result_ready" })
      .where(eq(aiEvaluation.id, replacement.id));
    await visible(true);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "obsolete", receipt: { retryEvaluationId: item.id } })
      .where(eq(aiEvaluation.id, replacement.id));
    await visible(true); // A terminal cycle is not settlement evidence.
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({
        receipt: { retryEvaluationId: crypto.randomUUID(), outcome: "applied" },
      })
      .where(eq(aiEvaluation.id, replacement.id));
    await visible(true); // A supported outcome cannot hide a dangling replacement.
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ receipt: null })
      .where(eq(aiEvaluation.id, replacement.id));
    await visible(false);
    const replacementOwner = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_refresh",
      trigger: "scheduled",
      execution: false,
    });
    const [last] = await getDb(ctx.db)
      .insert(aiEvaluation)
      .values({
        ...item,
        id: crypto.randomUUID(),
        runId: replacementOwner,
        workKey: crypto.randomUUID(),
        state: "completed",
        receipt: null,
      })
      .returning();
    if (!last) throw new Error("Missing synthetic final replacement");
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ receipt: { retryEvaluationId: last.id } })
      .where(eq(aiEvaluation.id, replacement.id));
    await visible(false); // A handoff can transfer responsibility to another owner.

    const [shared] = await getDb(ctx.db)
      .insert(aiEvaluation)
      .values({
        ...item,
        id: crypto.randomUUID(),
        runId: null,
        workKey: crypto.randomUUID(),
        state: "failed",
        receipt: null,
      })
      .returning();
    if (!shared) throw new Error("Missing synthetic shared evaluation");
    await getDb(ctx.db)
      .insert(aiEvaluationRequest)
      .values({
        runId,
        evaluationId: shared.id,
        receipt: { outcome: "applied" },
      });
    await visible(true); // A supported outcome does not settle failed work.
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "completed", receipt: { retryEvaluationId: "malformed" } })
      .where(eq(aiEvaluation.id, shared.id));
    await visible(false); // The request's receipt takes precedence over shared evidence.
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ receipt: null })
      .where(eq(aiEvaluationRequest.runId, runId));
    await visible(true);
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ cancelledAt: new Date(), receipt: null })
      .where(eq(aiEvaluationRequest.runId, runId));
    await visible(false);
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ receipt: { retryEvaluationId: crypto.randomUUID() } })
      .where(eq(aiEvaluationRequest.runId, runId));
    await visible(true); // Cancellation with an explicit handoff still validates its target.
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ receipt: { retryEvaluationId: last.id } })
      .where(eq(aiEvaluationRequest.runId, runId));
    await visible(false); // The explicit handoff does not require an old-owner request.
    await getDb(ctx.db)
      .insert(aiEvaluationRequest)
      .values({ runId, evaluationId: last.id });
    await visible(false);
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ receipt: null })
      .where(eq(aiEvaluationRequest.runId, runId));
    const { createUploadedImageRecord } =
      await import("~/server/domains/image/repo/image");
    const {
      createImageProcessingJob,
      IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
    } = await import("~/server/domains/image-processing/repo/image-processing");
    const { imageProcessingJob, image: imageTable } =
      await import("~/server/db/schema");
    const { parseEntityId } = await import("@cubby/schemas/identifiers");
    const image = await createUploadedImageRecord(ctx.db, {
      key: "tests/synthetic-attention.jpg",
      filename: "synthetic.jpg",
      contentType: "image/jpeg",
      size: 512,
    });
    await getDb(ctx.db)
      .update(imageTable)
      .set({ sha256: "c".repeat(64) })
      .where(eq(imageTable.id, image.id));
    const imageJobId = await createImageProcessingJob(ctx.db, {
      imageId: parseEntityId("image", image.id),
      kind: "describe_image",
      sourceContentHash: "c".repeat(64),
      processorRevision: IMAGE_APPLE_DESCRIPTION_PROCESSOR_REVISION,
      runId,
    });
    if (!imageJobId) throw new Error("Missing synthetic image job");
    await visible(true);
    await getDb(ctx.db)
      .update(imageProcessingJob)
      .set({ state: "ready" })
      .where(eq(imageProcessingJob.id, imageJobId));
    await visible(false);
    await enqueueJob(ctx.db, {
      key: "synthetic:historical-live",
      kind: "synthetic.demand",
      runId,
      input: {},
    });
    await visible(true);
    expect(
      (
        await getDb(ctx.db)
          .select({ result: aiEvaluation.result })
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, item.id))
      )[0]?.result,
    ).toEqual(item.result);
  });

  it("filters and sorts stalled Runs ahead of newer stopped Runs", async () => {
    const stalled = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const stopped = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      execution: false,
    });
    const stoppedHistories = [];
    for (const { failureCode, retiredAt } of [
      { failureCode: "user_cancelled", retiredAt: null },
      { failureCode: "dispatch_aborted", retiredAt: null },
      { failureCode: "agent_failed", retiredAt: new Date() },
    ]) {
      const cancelled = await ensureRun(ctx.db, ctx.actor, {
        purpose: "ai_suggest",
        trigger: "manual",
        execution: false,
      });
      const [history] = await getDb(ctx.db)
        .update(runTable)
        .set({ status: "failed", failureCode, retiredAt })
        .where(eq(runTable.id, cancelled))
        .returning({
          code: runTable.shortcode,
          failureCode: runTable.failureCode,
        });
      stoppedHistories.push(history!);
    }
    const old = new Date(Date.now() - 60 * 60_000);
    await getDb(ctx.db)
      .update(runTable)
      .set({ startedAt: old })
      .where(eq(runTable.id, stalled));
    await getDb(ctx.db)
      .update(runTable)
      .set({ status: "failed" })
      .where(eq(runTable.id, stopped));
    await enqueueJob(ctx.db, {
      key: "synthetic:attention-stall",
      kind: "synthetic.demand",
      runId: stalled,
      input: {},
    });
    const page = await runScaffold.read(ctx.db, {
      filters: { purpose: ["ai_suggest"], needsAttention: true },
      sorts: [
        { orderBy: "stalled", direction: "desc" },
        { orderBy: "startedAt", direction: "desc" },
      ],
      pagination: { pageIndex: 0, pageSize: 10 },
    });
    expect(page.data).toHaveLength(2);
    expect(page.data.map((row) => row.stalled)).toEqual([true, false]);
    expect(page.data.map((row) => row.status)).toEqual(["running", "failed"]);
    for (const history of stoppedHistories) {
      expect(await readRun(ctx.db, history.code)).toMatchObject({
        status: "failed",
        failureCode: history.failureCode,
      });
    }
  });
});
