import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { and, eq, sql } from "drizzle-orm";
import { createEntity } from "tooling/factories/create";
import { buildKernelContext } from "tooling/scenarios/context";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  enqueueAiEvaluation,
  evaluationSlotKey,
} from "~/server/ai/repo/ai-evaluation-requests";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { aiEvaluation, product, run } from "~/server/db/schema";
import { captureBackgroundQueue } from "~/server/testing/background-queue";
import { controlWorkflowRun } from "~/server/workflows/runs/control";
import { launchWorkflowRun } from "~/server/workflows/runs/lifecycle";

import {
  insertEvaluationTargets,
  scheduleEvaluationRun,
} from "./ai-refresh-state";
import { ensureRun, systemActor } from "./ensure-run";

// Real transactions expose races between shared Jobs and their requesters.
describe("AI refresh scheduling admission", () => {
  const ctx = withTestDb();
  const evaluationItems = async () =>
    z
      .object({ count: z.coerce.number() })
      .parse(
        (
          await getDb(ctx.db).execute(
            sql`SELECT count(*) AS count FROM "WorkItem" WHERE target = 'ai.evaluation'`,
          )
        ).rows[0],
      ).count;
  const aiEvaluationTicket = async (id: string) =>
    z
      .array(z.object({ ticket: z.coerce.number() }))
      .parse(
        (
          await getDb(ctx.db).execute(
            sql`SELECT ticket FROM "WorkItem" WHERE target = 'ai.evaluation' AND ref = ${id}::uuid`,
          )
        ).rows,
      )[0]?.ticket;
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

  // Repeated enrichment must leave one durable row and one Job, not a backlog.
  it("updates one Product slot and Job across three successive input changes", async () => {
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
    expect(rows).toHaveLength(1);
    expect(await evaluationItems()).toBe(1);
  });

  // Catalog and pair targets have distinct slots, even for the same Product.
  it("never replaces a shared pair evaluation with a catalog one", async () => {
    const recordId = crypto.randomUUID();
    const request = {
      ...input("product-pair"),
      input: aiRefreshRunInput.parse({
        ...input("product-pair").input,
        mailboxId: undefined,
      }),
    };
    const provenance = aiProvenance.parse({
      dependencies: [],
      inputFingerprint: "synthetic-pair",
      optionFingerprint: "",
      model: null,
    });
    // Pairs are shared work, enqueued as production does (pair snapshot).
    const owner = await ensureRun(ctx.db, systemActor(), input("pair-owner"));
    await enqueueAiEvaluation(ctx.db, {
      runId: owner,
      executionKind: "ai_refresh",
      feature: "product-identity",
      workKey: "product-identity:synthetic-pair",
      shareKey: "product-identity:synthetic-pair",
      target: aiEvaluationTarget.parse({
        kind: "product_pair",
        entity: "product",
        recordId,
        otherId: crypto.randomUUID(),
        field: null,
        assessmentIds: [],
      }),
      provenance,
      snapshot: {},
    });
    await scheduleEvaluationRun(ctx.db, systemActor(), request, [
      {
        target: aiEvaluationTarget.parse({
          kind: "product",
          entity: "product",
          recordId,
          field: null,
          assessmentIds: [],
        }),
        provenance: { ...provenance, inputFingerprint: "synthetic-catalog" },
        snapshot: {},
      },
    ]);
    const states = await getDb(ctx.db)
      .select({ state: aiEvaluation.state, target: aiEvaluation.target })
      .from(aiEvaluation)
      .where(eq(aiEvaluation.feature, "product-identity"));
    expect(states.map((row) => row.state).sort()).toEqual(["queued", "queued"]);
  });

  // Queued input changes spend no declined-attempt budget.
  it("keeps re-admitting a Product whose input keeps changing back", async () => {
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
      ...input("product-alternating"),
      input: aiRefreshRunInput.parse({
        ...input("product-alternating").input,
        mailboxId: undefined,
      }),
    };
    for (let round = 0; round < 5; round++)
      for (const fingerprint of ["synthetic-a", "synthetic-b"])
        await scheduleEvaluationRun(ctx.db, systemActor(), request, [
          productTarget(fingerprint),
        ]);
    await scheduleEvaluationRun(ctx.db, systemActor(), request, [
      productTarget("synthetic-a"),
    ]);
    const queued = await getDb(ctx.db)
      .select({ provenance: aiEvaluation.provenance })
      .from(aiEvaluation)
      .where(
        and(
          eq(aiEvaluation.feature, "product-identity"),
          eq(aiEvaluation.state, "queued"),
        ),
      );
    expect(queued).toEqual([
      {
        provenance: expect.objectContaining({
          inputFingerprint: "synthetic-a",
        }),
      },
    ]);
    expect(await evaluationItems()).toBe(1);
  });

  it("bounds declined attempts of the same input without linking receipts", async () => {
    const owner = await ensureRun(
      ctx.db,
      systemActor(),
      input("decline-budget"),
    );
    const item = target();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await insertEvaluationTargets(ctx.db, owner, [item])).toBe(1);
      await getDb(ctx.db)
        .update(aiEvaluation)
        .set({ state: "obsolete" })
        .where(eq(aiEvaluation.runId, owner));
    }
    expect(await insertEvaluationTargets(ctx.db, owner, [item])).toBe(0);
    const rows = await getDb(ctx.db).select().from(aiEvaluation);
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.workKey)).size).toBe(3);
    expect(rows.every((row) => row.receipt === null)).toBe(true);
    expect(
      await insertEvaluationTargets(ctx.db, owner, [
        {
          ...item,
          provenance: {
            ...item.provenance,
            inputFingerprint: "synthetic-changed",
          },
        },
      ]),
    ).toBe(1);
  });

  it("retains a paid result, updates one queued successor in place, and creates a new row on a settled revert", async () => {
    const owner = await ensureRun(ctx.db, systemActor(), input("ready-slot"));
    const item = target();
    const changed = {
      ...item,
      provenance: { ...item.provenance, inputFingerprint: "synthetic-next" },
      snapshot: { revision: 2 },
    };
    await insertEvaluationTargets(ctx.db, owner, [item]);
    const [first] = await getDb(ctx.db).select().from(aiEvaluation);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "result_ready", result: { input: "synthetic-first" } })
      .where(eq(aiEvaluation.id, first!.id));
    expect(await insertEvaluationTargets(ctx.db, owner, [item])).toBe(0);
    expect(await insertEvaluationTargets(ctx.db, owner, [changed])).toBe(1);
    const [queued] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.state, "queued"));
    const third = {
      ...changed,
      provenance: {
        ...changed.provenance,
        inputFingerprint: "synthetic-third",
      },
    };
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({
        result: { input: "synthetic-next" },
        receipt: { reason: "synthetic-old-input" },
        error: "Synthetic earlier failure",
      })
      .where(eq(aiEvaluation.id, queued!.id));
    const before = await aiEvaluationTicket(queued!.id);
    await insertEvaluationTargets(ctx.db, owner, [third]);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, queued!.id))
      )[0],
    ).toMatchObject({
      state: "queued",
      snapshot: changed.snapshot,
      provenance: third.provenance,
      result: null,
      receipt: null,
      error: null,
    });
    // Re-input supersedes any attempt holding the previous input's ticket.
    expect(await aiEvaluationTicket(queued!.id)).toBeGreaterThan(before!);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, first!.id))
      )[0],
    ).toMatchObject({ state: "result_ready", provenance: item.provenance });
    await getDb(ctx.db).update(aiEvaluation).set({ state: "completed" });
    expect(await insertEvaluationTargets(ctx.db, owner, [third])).toBe(0);
    expect(await insertEvaluationTargets(ctx.db, owner, [item])).toBe(1);
    const rows = await getDb(ctx.db).select().from(aiEvaluation);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.state === "queued")).toHaveLength(1);
    expect(new Set(rows.map((row) => row.workKey)).size).toBe(3);
  });

  it("enforces queued slot uniqueness in SQL and matches UTF-8 key lengths", async () => {
    const owner = await ensureRun(ctx.db, systemActor(), input("slot-index"));
    const item = {
      ...target(),
      target: aiEvaluationTarget.parse({
        kind: "field",
        entity: "product",
        recordId: crypto.randomUUID(),
        field: "synthetic:café",
        assessmentIds: [],
      }),
    };
    await insertEvaluationTargets(ctx.db, owner, [item]);
    const [first] = await getDb(ctx.db).select().from(aiEvaluation);
    expect(first?.slotKey).toBe(
      evaluationSlotKey({ feature: "field-suggestion", target: item.target }),
    );
    expect(
      await getDb(ctx.db)
        .insert(aiEvaluation)
        .values({
          runId: owner,
          feature: "field-suggestion",
          workKey: "synthetic-duplicate-slot",
          target: item.target,
          provenance: {
            ...item.provenance,
            inputFingerprint: "synthetic-other",
          },
          snapshot: {},
          state: "queued",
        })
        .onConflictDoNothing()
        .returning(),
    ).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.state, "queued")),
    ).toHaveLength(1);
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
