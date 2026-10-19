import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
  aiRefreshProgress,
} from "@cubby/schemas/ai-evaluation";
import { MAX_AUTOMATIC_WORKFLOW_FAILURES } from "@cubby/schemas/workflow-runs";
import { and, eq } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it } from "vitest";

import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, product, run } from "~/server/db/schema";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import { createSystemUserFixture } from "~/server/testing/repo.fixtures";
import { controlWorkflowRun } from "~/server/workflows/runs/control";
import type { WorkflowLauncher } from "~/server/workflows/runs/launcher";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import {
  aiRefreshRelaunchCandidates,
  insertEvaluationTargets,
  scheduleEvaluationRun,
} from "./ai-refresh-state";
import { ensureRun, systemActor } from "./ensure-run";

// Real transactions expose scheduling races; the Workflow provider is the only external seam.
describe("AI refresh scheduling admission", () => {
  const ctx = withTestDb();
  beforeEach(() => createSystemUserFixture(ctx.db));
  const launcher: WorkflowLauncher = {
    create: async () => undefined,
    terminate: async () => undefined,
    status: async () => ({ state: "running", error: null }),
  };
  const target = (recordId = crypto.randomUUID()) => ({
    target: aiEvaluationTarget.parse({
      kind: "email",
      entity: "email",
      recordId,
      field: null,
      assessmentIds: [],
    }),
    provenance: aiProvenance.parse({
      dependencies: [],
      inputFingerprint: "synthetic-input",
      optionFingerprint: "",
      model: null,
    }),
    snapshot: {},
  });
  const input = (key: string) => ({
    purpose: "ai_refresh" as const,
    trigger: "scheduled" as const,
    status: "running" as const,
    clientKey: `synthetic-refresh:${key}`,
    input: aiRefreshRunInput.parse({
      kind: "ai_refresh",
      mailboxId: "synthetic-mailbox",
      activation: {
        release: "synthetic-release",
        enabled: true,
        manifest: {},
        activatedAt: "2026-10-01T00:00:00Z",
      },
    }),
  });
  const active = () =>
    getDb(ctx.db)
      .select()
      .from(run)
      .where(and(eq(run.purpose, "ai_refresh"), eq(run.status, "running")));

  it("bounds concurrent frozen rosters and resumes deferred work after capacity is released", async () => {
    const requests = [target(), target(), target()];
    await Promise.all(
      requests.map((item, index) =>
        scheduleEvaluationRun(ctx.db, systemActor(), input(`mail-${index}`), [
          item,
        ]),
      ),
    );
    // A nonblocking contender may defer before either slot fills; retry the durable sources.
    for (const [index, item] of requests.entries())
      await scheduleEvaluationRun(
        ctx.db,
        systemActor(),
        input(`mail-${index}`),
        [item],
      );
    const owners = await active();
    expect(owners).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(aiEvaluation)).toHaveLength(2);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(run.id, owners[0]!.id));
    for (const [index, item] of requests.entries())
      await scheduleEvaluationRun(
        ctx.db,
        systemActor(),
        input(`mail-${index}`),
        [item],
      );
    expect(await active()).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(aiEvaluation)).toHaveLength(3);
  });

  it("keeps cancelled work stopped through rediscovery and automatic recovery", async () => {
    const item = target();
    await scheduleEvaluationRun(ctx.db, systemActor(), input("cancelled"), [
      item,
    ]);
    const [owner] = await active();
    await controlWorkflowRun(
      ctx.db,
      systemActor(),
      { runPublicId: owner!.shortcode, action: "cancel" },
      "ai_refresh",
      launcher,
    );
    await scheduleEvaluationRun(ctx.db, systemActor(), input("cancelled"), [
      item,
    ]);
    expect(
      await launchWorkflowRun(
        ctx.db,
        { runId: owner!.id, purpose: "ai_refresh", automatic: true },
        launcher,
      ),
    ).toBeNull();
    expect(await active()).toHaveLength(0);
    expect(
      (await getDb(ctx.db).select().from(run).where(eq(run.id, owner!.id)))[0],
    ).toMatchObject({ status: "failed", failureCode: "user_cancelled" });
    expect((await getDb(ctx.db).select().from(aiEvaluation))[0]).toMatchObject({
      state: "cancelled",
      runId: owner!.id,
    });
  });

  it("does not reopen settled work belonging to a member-cancelled Run", async () => {
    const item = target();
    await scheduleEvaluationRun(
      ctx.db,
      systemActor(),
      input("cancelled-settled"),
      [item],
    );
    const [owner] = await active();
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "obsolete", receipt: { reason: "synthetic-fence" } })
      .where(eq(aiEvaluation.runId, owner!.id));
    await controlWorkflowRun(
      ctx.db,
      systemActor(),
      { runPublicId: owner!.shortcode, action: "cancel" },
      "ai_refresh",
      launcher,
    );
    await scheduleEvaluationRun(
      ctx.db,
      systemActor(),
      input("cancelled-settled"),
      [item],
    );
    expect(await active()).toHaveLength(0);
    expect(await getDb(ctx.db).select().from(aiEvaluation)).toHaveLength(1);
  });

  it("refuses an implicit launch after cancellation but permits the member's explicit retry", async () => {
    await scheduleEvaluationRun(
      ctx.db,
      systemActor(),
      input("implicit-launch"),
      [target()],
    );
    const [owner] = await active();
    await controlWorkflowRun(
      ctx.db,
      systemActor(),
      { runPublicId: owner!.shortcode, action: "cancel" },
      "ai_refresh",
      launcher,
    );
    // A Sweep finishing its child's roster is an implicit launch, not member retry.
    await expect(
      launchWorkflowRun(
        ctx.db,
        { runId: owner!.id, purpose: "ai_refresh" },
        launcher,
      ),
    ).rejects.toThrow(/cancelled/);
    await controlWorkflowRun(
      ctx.db,
      systemActor(),
      { runPublicId: owner!.shortcode, action: "retry" },
      "ai_refresh",
      launcher,
    );
    expect((await active())[0]?.id).toBe(owner!.id);
    expect(
      (await getDb(ctx.db).select().from(aiEvaluation))
        .map((row) => row.state)
        .sort(),
    ).toEqual(["cancelled", "queued"]);
  });

  it("does not spend its recovery budget on exhausted failures", async () => {
    for (let index = 0; index < 11; index++) {
      const id = await ensureRun(
        ctx.db,
        systemActor(),
        input(`failed-${index}`),
      );
      await insertEvaluationTargets(ctx.db, id, [target()]);
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "failed",
          failureCode: "workflow_dispatch_failed",
          progress: aiRefreshProgress.parse({
            attempt: 3,
            automaticRecoveryFailures: MAX_AUTOMATIC_WORKFLOW_FAILURES,
          }),
          updatedAt: new Date(0),
        })
        .where(eq(run.id, id));
    }
    const fresh = await ensureRun(ctx.db, systemActor(), input("fresh"));
    await insertEvaluationTargets(ctx.db, fresh, [target()]);
    expect(await aiRefreshRelaunchCandidates(ctx.db)).toEqual([{ id: fresh }]);
  });

  it("bounds recovery of historical failed Runs by the same execution slots", async () => {
    const ids = [];
    for (let index = 0; index < 3; index++) {
      const id = await ensureRun(
        ctx.db,
        systemActor(),
        input(`recovery-${index}`),
      );
      await getDb(ctx.db)
        .update(run)
        .set({ status: "failed", failureCode: "workflow_dispatch_failed" })
        .where(eq(run.id, id));
      ids.push(id);
    }
    await Promise.all(
      ids.map((id) =>
        launchWorkflowRun(
          ctx.db,
          { runId: id, purpose: "ai_refresh", automatic: true },
          launcher,
        ),
      ),
    );
    for (const id of ids)
      await launchWorkflowRun(
        ctx.db,
        { runId: id, purpose: "ai_refresh", automatic: true },
        launcher,
      );
    expect(await active()).toHaveLength(2);
  });

  it("keeps member Product creation successful when automatic connection work is deferred", async () => {
    const queue = captureBackgroundQueue();
    try {
      await activateAiRefresh(ctx.db, "synthetic-busy-member-write", {
        enabled: true,
      });
      await ensureRun(ctx.db, systemActor(), input("busy-mail-one"));
      await ensureRun(ctx.db, systemActor(), input("busy-mail-two"));
      const created = await createEntity(
        buildKernelContext(ctx.db, ctx.actor.userId),
        "product",
        { name: "Synthetic busy refresh hammer" },
      );
      expect(
        (
          await getDb(ctx.db)
            .select({ name: product.name })
            .from(product)
            .where(eq(product.shortcode, created.id))
        )[0],
      ).toEqual({ name: "Synthetic busy refresh hammer" });
      expect(await active()).toHaveLength(2);
    } finally {
      queue.restore();
    }
  });

  it("launches unstarted slot owners before older failures blocked by their capacity", async () => {
    for (let index = 0; index < 10; index++) {
      const id = await ensureRun(
        ctx.db,
        systemActor(),
        input(`waiting-failure-${index}`),
      );
      await insertEvaluationTargets(ctx.db, id, [target()]);
      await getDb(ctx.db)
        .update(run)
        .set({
          status: "failed",
          failureCode: "workflow_dispatch_failed",
          updatedAt: new Date(0),
        })
        .where(eq(run.id, id));
    }
    const unstarted = [];
    for (let index = 0; index < 2; index++) {
      const id = await ensureRun(
        ctx.db,
        systemActor(),
        input(`slot-owner-${index}`),
      );
      await insertEvaluationTargets(ctx.db, id, [target()]);
      unstarted.push(id);
    }
    expect(
      (await aiRefreshRelaunchCandidates(ctx.db))
        .slice(0, 2)
        .map((row) => row.id)
        .sort(),
    ).toEqual(unstarted.sort());
  });

  it("does not join a new activation's work to an older policy Run", async () => {
    const request = (revision: number) => ({
      ...input(`policy-${revision}`),
      input: aiRefreshRunInput.parse({
        ...input("policy").input,
        mailboxId: undefined,
        activation: { ...input("policy").input.activation, revision },
      }),
    });
    const productTarget = () => ({
      ...target(),
      target: aiEvaluationTarget.parse({
        kind: "product",
        entity: "product",
        recordId: crypto.randomUUID(),
        field: null,
        assessmentIds: [],
      }),
    });
    const prior = await scheduleEvaluationRun(
      ctx.db,
      systemActor(),
      request(1),
      [productTarget()],
    );
    const current = await scheduleEvaluationRun(
      ctx.db,
      systemActor(),
      request(2),
      [productTarget()],
    );
    expect(prior.kind).toBe("scheduled");
    expect(current.kind).toBe("scheduled");
    if (prior.kind !== "scheduled" || current.kind !== "scheduled") return;
    expect(current.runId).not.toBe(prior.runId);
  });
});
