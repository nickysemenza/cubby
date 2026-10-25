import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { and, eq } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, product, run } from "~/server/db/schema";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import { controlWorkflowRun } from "~/server/workflows/runs/control";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import { scheduleEvaluationRun } from "./ai-refresh-state";
import { ensureRun, systemActor } from "./ensure-run";

// Real transactions expose races between shared Jobs and their requesters.
describe("AI refresh scheduling admission", () => {
  const ctx = withTestDb();
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

  // An inherited owner prevents ensureRun from advancing a successor key.
  it("rejects Run-scoped scheduling before inheriting an owner", async () => {
    const id = await ensureRun(ctx.db, systemActor(), input("scoped-owner"));
    await expect(
      scheduleEvaluationRun(
        ctx.db,
        { ...systemActor(), runId: id },
        input("scoped-child"),
        [target()],
      ),
    ).rejects.toThrow("Run-scoped");
    expect(await getDb(ctx.db).select().from(aiEvaluation)).toHaveLength(0);
  });

  // Explicit rediscovery must report deferred readmission without resetting its recovery budget.
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
    );
    await scheduleEvaluationRun(ctx.db, systemActor(), input("cancelled"), [
      item,
    ]);
    expect(
      await launchWorkflowRun(ctx.db, {
        runId: owner!.id,
        purpose: "ai_refresh",
        automatic: true,
      }),
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
    );
    // A Sweep finishing its child's roster is an implicit launch, not member retry.
    await expect(
      launchWorkflowRun(ctx.db, {
        runId: owner!.id,
        purpose: "ai_refresh",
        automatic: true,
      }),
    ).resolves.toBeNull();
    await controlWorkflowRun(
      ctx.db,
      systemActor(),
      { runPublicId: owner!.shortcode, action: "retry" },
      "ai_refresh",
    );
    expect((await active())[0]?.id).toBe(owner!.id);
    expect(
      (await getDb(ctx.db).select().from(aiEvaluation))
        .map((row) => row.state)
        .sort(),
    ).toEqual(["cancelled", "queued"]);
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

  // Production finding: each photo description that landed changed a
  // Product's identity fingerprint, and the ai_refresh pass queued another
  // evaluation each time beside the older ones (7,812 queued for 3,373
  // Products, up to 24 for one). A newer fingerprint now replaces the older
  // queued evaluation, as connection evaluations already did.
  it("replaces a Product's older queued identity evaluation", async () => {
    const recordId = crypto.randomUUID();
    const productTarget = (inputFingerprint: string) => ({
      target: aiEvaluationTarget.parse({
        kind: "product",
        entity: "product",
        recordId,
        field: null,
        assessmentIds: [],
      }),
      provenance: aiProvenance.parse({
        dependencies: [],
        inputFingerprint,
        optionFingerprint: "",
        model: null,
      }),
      snapshot: {},
    });
    const request = {
      ...input("product-identity"),
      input: aiRefreshRunInput.parse({
        ...input("product-identity").input,
        mailboxId: undefined,
      }),
    };
    for (const fingerprint of ["synthetic-a", "synthetic-b", "synthetic-c"])
      await scheduleEvaluationRun(ctx.db, systemActor(), request, [
        productTarget(fingerprint),
      ]);
    const rows = await getDb(ctx.db)
      .select({
        state: aiEvaluation.state,
        provenance: aiEvaluation.provenance,
      })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.feature, "product-identity"));
    expect(rows.filter((row) => row.state === "queued")).toEqual([
      expect.objectContaining({
        provenance: expect.objectContaining({
          inputFingerprint: "synthetic-c",
        }),
      }),
    ]);
    expect(rows.filter((row) => row.state === "cancelled")).toHaveLength(2);
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

  it("checks the policy revision when an obsolete target reuses the same client key", async () => {
    const request = (revision: number) => ({
      ...input("same-policy-key"),
      input: aiRefreshRunInput.parse({
        ...input("policy").input,
        mailboxId: undefined,
        activation: { ...input("policy").input.activation, revision },
      }),
    });
    const item = {
      ...target(),
      target: aiEvaluationTarget.parse({
        kind: "product",
        entity: "product",
        recordId: crypto.randomUUID(),
        field: null,
        assessmentIds: [],
      }),
    };
    const prior = await scheduleEvaluationRun(
      ctx.db,
      systemActor(),
      request(1),
      [item],
    );
    expect(prior.kind).toBe("scheduled");
    if (prior.kind !== "scheduled") return;
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "obsolete" })
      .where(eq(aiEvaluation.runId, prior.runId));
    const current = await scheduleEvaluationRun(
      ctx.db,
      systemActor(),
      request(2),
      [item],
    );
    expect(current.kind).toBe("scheduled");
    if (current.kind !== "scheduled") return;
    expect(current.runId).not.toBe(prior.runId);
  });
});
