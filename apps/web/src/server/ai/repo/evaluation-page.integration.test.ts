import {
  aiEvaluationTarget,
  aiProvenance,
  aiRefreshRunInput,
} from "@cubby/schemas/ai-evaluation";
import { and, eq, inArray } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { dependencyStamps } from "~/server/ai/policy/refresh-manifest";
import {
  claimAiEvaluationPage,
  failAiEvaluationPage,
  publishAiEvaluationPage,
} from "~/server/ai/repo/ai-evaluation";
import {
  enqueueAiEvaluation,
  enqueueAiEvaluations,
} from "~/server/ai/repo/ai-evaluation-requests";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import type {
  EvaluationPageAdapter,
  EvaluationPageTarget,
} from "~/server/ai/repo/evaluation-page";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  job,
  run,
} from "~/server/db/schema";
import { readAiRefreshWorkSummary } from "~/server/domains/run/repo/ai-work-state";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { executeAiRefreshPage } from "~/server/domains/run/service/ai-refresh";
import { JobDeferredError } from "~/server/generic/jobs/errors";
import * as kindPolicy from "~/server/generic/jobs/kind-policy";
import {
  claimJob,
  jobRunOwned,
} from "~/server/generic/jobs/repo/external-claim";
import { enqueueJob } from "~/server/generic/jobs/repo/producer";
import {
  claimJobPage,
  renewJobPage,
  dueJobs,
} from "~/server/generic/jobs/repo/queue";
import {
  drainDueJobs,
  defineJobHandler,
} from "~/server/generic/jobs/service/jobs";
import { cancelRunAiWork } from "~/server/workflows/runs/control";
import { aiEvaluationJobHandler } from "~/server/workflows/runs/job-execution";

const receipt = (target: EvaluationPageTarget) => ({
  evaluationId: target.evaluation.id,
  state: "completed" as const,
  receipt: { synthetic: true },
});

// Real pooled transactions exercise SKIP LOCKED, slot uniqueness and publication authority.
describe("finite AI evaluation pages", () => {
  const ctx = withTestDb();
  async function seed(
    count: number,
    feature = "product-identity",
    purpose: "ai_refresh" | "ai_suggest" = "ai_refresh",
  ) {
    const activation = await activateAiRefresh(
      ctx.db,
      "synthetic-page-release",
      { enabled: true },
    );
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose,
      trigger: "scheduled",
      status: "running",
      input: aiRefreshRunInput.parse({ kind: "ai_refresh", activation }),
    });
    const inputs = Array.from({ length: count }, (_, sequence) => ({
      input: {
        runId,
        executionKind: "ai_refresh" as const,
        shareKey: null,
        feature,
        target: aiEvaluationTarget.parse({
          kind: "product",
          entity: "product",
          recordId: crypto.randomUUID(),
          field: null,
          assessmentIds: [],
        }),
        provenance: aiProvenance.parse({
          dependencies: dependencyStamps(activation.manifest, [
            "product-identity",
          ]),
          inputFingerprint: `synthetic-input-${sequence}`,
          optionFingerprint: "synthetic-options",
          model: null,
        }),
        snapshot: {},
      },
      sequence,
    }));
    const rows = await enqueueAiEvaluations(ctx.db, inputs);
    const jobs = await getDb(ctx.db)
      .select()
      .from(job)
      .where(
        inArray(
          job.key,
          rows.map((row) => `ai-evaluation:${row.id}`),
        ),
      );
    return { runId, rows, jobs, inputs };
  }
  const finish = (targets: readonly EvaluationPageTarget[]) =>
    publishAiEvaluationPage(
      ctx.db,
      targets.map((target) => ({
        target,
        evidenceDigest: target.evaluation.provenance.inputFingerprint,
        outcome: null,
      })),
      async (_tx, valid) => valid.map((entry) => receipt(entry.target)),
    );

  it("claims disjoint pages concurrently and renews only exact live tokens", async () => {
    const seeded = await seed(12);
    await getDb(ctx.db)
      .update(job)
      .set({ runId: seeded.runId })
      .where(
        inArray(
          job.id,
          seeded.jobs.map((row) => row.id),
        ),
      );
    const pages = await Promise.all([
      claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id, 6),
      claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id, 6),
    ]);
    const targets = pages.flat();
    expect(targets).toHaveLength(12);
    expect(new Set(targets.map((entry) => entry.claim.id)).size).toBe(12);
    expect(new Set(targets.map((entry) => entry.claim.leaseToken)).size).toBe(
      12,
    );
    const replaced = targets[0]!;
    await getDb(ctx.db)
      .update(job)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(job.id, replaced.claim.id));
    const replacement = await claimJob(ctx.db, replaced.claim.id);
    expect(replacement?.leaseToken).not.toBe(replaced.claim.leaseToken);
    const renewed = await renewJobPage(
      ctx.db,
      targets.map((entry) => entry.claim),
    );
    expect(renewed).toHaveLength(11);
    expect(renewed).not.toContain(replaced.claim.id);
    expect(await finish([replaced])).toEqual([]);
    const before = targets[1]!.claim.generation;
    expect((await finish(targets.slice(1))).length).toBe(11);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.id, targets[1]!.claim.id))
      )[0]?.generation,
    ).toBe(before);
  }, 30_000);

  it("shares capped kind admission with single claims until every page lease settles", async () => {
    const seeded = await seed(102);
    const original = kindPolicy.jobKindPolicy;
    // Exercise the same cross-Worker cap used by the configured AI policy.
    const policy = vi
      .spyOn(kindPolicy, "jobKindPolicy")
      .mockImplementation((kind) => ({
        ...original(kind),
        ...(kind === "ai.evaluation" ? { maxInFlight: 1 } : {}),
      }));
    try {
      const first = await countTestDbQueries(() =>
        claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id, 100),
      );
      expect(first.result).toHaveLength(100);
      expect(first.queryCount).toBe(15);
      const owned = new Set(first.result.map((target) => target.claim.id));
      const remaining = seeded.jobs.filter((row) => !owned.has(row.id));
      const blocked = await Promise.all([
        claimAiEvaluationPage(ctx.db, remaining[0]!.id),
        claimJob(ctx.db, remaining[1]!.id),
      ]);
      expect(blocked).toEqual([[], null]);
      for (let offset = 1; offset < first.result.length; offset += 25)
        await finish(first.result.slice(offset, offset + 25));
      expect(await claimJob(ctx.db, remaining[0]!.id)).toBeNull();
      await finish(first.result.slice(0, 1));
      const [page, single] = await Promise.all([
        claimAiEvaluationPage(ctx.db, remaining[0]!.id, 1),
        claimJob(ctx.db, remaining[1]!.id),
      ]);
      expect(page.length + Number(single !== null)).toBe(1);
      expect(
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(and(eq(job.kind, "ai.evaluation"), eq(job.state, "running"))),
      ).toHaveLength(1);
    } finally {
      policy.mockRestore();
    }
  }, 30_000);

  it("SKIP LOCKED does not wait on a foreign open transaction", async () => {
    const seeded = await seed(4);
    await getDb(ctx.db)
      .update(job)
      .set({ runId: seeded.runId })
      .where(
        inArray(
          job.id,
          seeded.jobs.map((row) => row.id),
        ),
      );
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const owner = withTransactionDatabase(ctx.db, async (tx) => {
      const claimed = await claimJobPage(tx, {
        where: eq(job.kind, "ai.evaluation"),
        limit: 2,
      });
      holding.resolve();
      await release.promise;
      return claimed;
    });
    await holding.promise;
    let other;
    try {
      other = await claimJobPage(ctx.db, {
        where: eq(job.kind, "ai.evaluation"),
        limit: 4,
      });
    } finally {
      release.resolve();
    }
    const first = await owner;
    expect(first).toHaveLength(2);
    expect(other).toHaveLength(2);
    expect(new Set([...first, ...other!].map((entry) => entry.id)).size).toBe(
      seeded.jobs.length,
    );
  });

  it("keeps one queued successor when a captured attempt fails", async () => {
    const seeded = await seed(1);
    const [target] = await claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id);
    const changed = await enqueueAiEvaluation(ctx.db, {
      ...seeded.inputs[0]!.input,
      provenance: {
        ...seeded.inputs[0]!.input.provenance,
        inputFingerprint: "synthetic-new-input",
      },
    });
    expect(changed.id).not.toBe(target!.evaluation.id);
    await failAiEvaluationPage(ctx.db, [
      {
        target: target!,
        state: "retry_wait",
        error: "Synthetic interrupted attempt",
      },
    ]);
    const rows = await getDb(ctx.db).select().from(aiEvaluation);
    expect(rows.find((row) => row.id === changed.id)?.state).toBe("queued");
    expect(rows.find((row) => row.id === target!.evaluation.id)?.state).toBe(
      "obsolete",
    );
    expect(
      rows.filter((row) => ["queued", "retry_wait"].includes(row.state)),
    ).toHaveLength(1);
    expect(await finish([target!])).toEqual([]);
  });

  it("settles receipt sets, preserves explicit retry receipts, and wakes each coordinator", async () => {
    const seeded = await seed(3);
    await enqueueJob(ctx.db, {
      key: `run:${seeded.runId}`,
      kind: "run.execute",
      input: {},
      availableAt: new Date(Date.now() + 60_000),
    });
    await getDb(ctx.db)
      .update(aiEvaluationRequest)
      .set({ receipt: { retryEvaluationId: crypto.randomUUID() } })
      .where(eq(aiEvaluationRequest.evaluationId, seeded.rows[0]!.id));
    const targets = await claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id);
    const measured = await countTestDbQueries(() => finish(targets));
    expect(measured.result).toHaveLength(3);
    expect(
      measured.statements.filter((statement) =>
        statement.startsWith('update "Job"'),
      ),
    ).toHaveLength(2);
    const requests = await getDb(ctx.db).select().from(aiEvaluationRequest);
    expect(
      requests.find((entry) => entry.evaluationId === seeded.rows[0]!.id)
        ?.receipt,
    ).toHaveProperty("retryEvaluationId");
    expect(
      requests.filter(
        (entry) =>
          z.object({ synthetic: z.boolean() }).safeParse(entry.receipt).success,
      ),
    ).toHaveLength(2);
    const coordinator = (
      await getDb(ctx.db)
        .select()
        .from(job)
        .where(eq(job.key, `run:${seeded.runId}`))
    )[0]!;
    expect(coordinator.availableAt.getTime()).toBeLessThan(Date.now() + 1000);
  });

  it("withdraws a requester without revoking another live requester", async () => {
    const seeded = await seed(1);
    // Shared non-refresh execution can adopt the remaining requester's authority.
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ executionKind: "suggestion_sweep" })
      .where(eq(aiEvaluation.id, seeded.rows[0]!.id));
    const otherRun = await ensureRun(ctx.db, ctx.actor, {
      purpose: "suggestion_sweep",
      trigger: "scheduled",
      status: "running",
    });
    await getDb(ctx.db).insert(aiEvaluationRequest).values({
      runId: otherRun,
      evaluationId: seeded.rows[0]!.id,
      sequence: 0,
    });
    const targets = await claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed" })
      .where(eq(run.id, seeded.runId));
    await cancelRunAiWork(ctx.db, seeded.runId, "Synthetic cancellation", {
      owned: false,
      requested: true,
    });
    expect(await finish(targets)).toHaveLength(1);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluationRequest)
          .where(eq(aiEvaluationRequest.runId, otherRun))
      )[0]?.receipt,
    ).toEqual({ synthetic: true });
  });

  it("fences activation changes and cancellation before any business write", async () => {
    const seeded = await seed(2);
    const targets = await claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id);
    await activateAiRefresh(ctx.db, "synthetic-disabled", { enabled: false });
    expect(await finish(targets)).toEqual([]);
    await cancelRunAiWork(ctx.db, seeded.runId, "Synthetic member stop");
    expect(await finish(targets)).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(aiEvaluation)).every(
        (row) => row.state === "cancelled",
      ),
    ).toBe(true);
  });

  it("isolates preparation and publication failures without replaying committed siblings", async () => {
    const seeded = await seed(6);
    const targets = await claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id);
    const calls = new Map<string, number>();
    const badPreparation = targets[0]!.evaluation.id;
    const stale = targets[1]!.evaluation.id;
    const adapter: EvaluationPageAdapter<null, null> = {
      operation: "product-identity",
      prepare: async (_db, entries) =>
        entries.map((target) =>
          target.evaluation.id === badPreparation
            ? {
                kind: "failed",
                target,
                error: new Error("Synthetic preparation failure"),
              }
            : {
                kind: "ready",
                target,
                evidenceDigest: target.evaluation.provenance.inputFingerprint,
                prepared: null,
              },
        ),
      evaluate: async () => null,
      publish: async (tx, outcomes) => {
        if (outcomes.some((entry) => entry.target.evaluation.id === stale))
          throw new Error("Synthetic evidence changed during inference");
        for (const entry of outcomes) {
          const id = entry.target.evaluation.id;
          await getDb(tx)
            .update(aiEvaluation)
            .set({ result: { synthetic: true } })
            .where(eq(aiEvaluation.id, id));
        }
        return outcomes.map((entry) => {
          const id = entry.target.evaluation.id;
          calls.set(id, (calls.get(id) ?? 0) + 1);
          return receipt(entry.target);
        });
      },
    };
    await executeAiRefreshPage(ctx.db, targets, adapter);
    const rows = await getDb(ctx.db).select().from(aiEvaluation);
    expect(rows.filter((row) => row.state === "completed")).toHaveLength(4);
    expect(rows.find((row) => row.id === badPreparation)?.state).toBe(
      "retry_wait",
    );
    expect(rows.find((row) => row.id === stale)?.state).toBe("obsolete");
    expect([...calls.values()]).toEqual([1, 1, 1, 1]);
  });

  it("admits one feature turn per fair round and preserves backfill's reserved share", async () => {
    const catalog = await seed(40);
    const member = await seed(1, "field-suggestion", "ai_suggest");
    await seed(1, "entity-connections", "ai_suggest");
    const other = await enqueueJob(ctx.db, {
      key: "synthetic-other-kind",
      kind: "synthetic.other",
      input: {},
    });
    const owned = await getDb(ctx.db)
      .select({ owned: jobRunOwned() })
      .from(job)
      .where(eq(job.id, member.jobs[0]!.id));
    expect(owned[0]?.owned).toBe(true);
    const first = await dueJobs(ctx.db);
    // Each feature contributes at most one anchor per round. Both member Run
    // features lead; the background feature fits within the kind cap.
    const aiAnchors = first.filter((entry) => entry.kind === "ai.evaluation");
    expect(aiAnchors).toHaveLength(3);
    expect(new Set(aiAnchors.map((entry) => entry.pageKey)).size).toBe(3);
    expect(first.some((entry) => entry.id === other.id)).toBe(true);
    const visits: string[] = [];
    const scalar = defineJobHandler(z.object({}), async () => ({
      page: { done: true },
    }));
    await drainDueJobs(
      ctx.db,
      {
        "synthetic.other": scalar,
        "run.execute": scalar,
        "ai.evaluation": {
          ...scalar,
          advancePage: async (db, id) => {
            const page = await claimAiEvaluationPage(db, id, 25);
            visits.push(page[0]!.evaluation.feature);
            await finish(page);
            return "succeeded";
          },
        },
      },
      7,
      20_000,
      1,
    );
    expect(visits).toContain("product-identity");
    expect(visits).toContain("field-suggestion");
    expect(visits).toContain("entity-connections");
    expect(visits.slice(0, 3).sort()).toEqual([
      "entity-connections",
      "field-suggestion",
      "product-identity",
    ]);
    const catalogTurns = visits.filter(
      (feature) => feature === "product-identity",
    ).length;
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(
            and(
              eq(aiEvaluation.runId, catalog.runId),
              eq(aiEvaluation.state, "queued"),
            ),
          )
      ).length,
    ).toBe(Math.max(0, 40 - 25 * catalogTurns));
  }, 30_000);
  it("releases funding waits without spending an attempt or holding completed siblings", async () => {
    const seeded = await seed(2);
    const targets = await claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id);
    const waiting = targets[0]!;
    const until = new Date(Date.now() + 60_000);
    const adapter: EvaluationPageAdapter<null, null> = {
      operation: "product-identity",
      prepare: async (_db, entries) =>
        entries.map((target) => ({
          kind: "ready",
          target,
          evidenceDigest: target.evaluation.provenance.inputFingerprint,
          prepared: null,
        })),
      evaluate: async (_db, entry) => {
        if (entry.target === waiting)
          throw new JobDeferredError(
            "Synthetic funding window",
            until,
            "ai_funding_window",
          );
        return null;
      },
      publish: async (_tx, entries) =>
        entries.map((entry) => receipt(entry.target)),
    };
    await executeAiRefreshPage(ctx.db, targets, adapter);
    const jobs = await getDb(ctx.db)
      .select()
      .from(job)
      .where(
        inArray(
          job.id,
          targets.map((entry) => entry.claim.id),
        ),
      );
    expect(jobs.find((entry) => entry.id === waiting.claim.id)).toMatchObject({
      state: "queued",
      attempts: 0,
      waitReason: "ai_funding_window",
      leaseToken: null,
    });
    expect(jobs.filter((entry) => entry.state === "completed")).toHaveLength(1);
  });
  it.each(["ai_refresh", "suggestion_sweep", "mail_reclassify"] as const)(
    "reuses completed input only for automatic refresh (%s)",
    async (executionKind) => {
      const seeded = await seed(1);
      await getDb(ctx.db)
        .update(aiEvaluation)
        .set({ executionKind })
        .where(eq(aiEvaluation.id, seeded.rows[0]!.id));
      const targets = await claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id);
      expect(await finish(targets)).toHaveLength(1);
      const next = await enqueueAiEvaluation(ctx.db, {
        ...seeded.inputs[0]!.input,
        executionKind,
      });
      expect(next.id === seeded.rows[0]!.id).toBe(
        executionKind === "ai_refresh",
      );
    },
  );
  it("claims while the coordinator holds its Run progress lock", async () => {
    const seeded = await seed(4);
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const progress = withTransactionDatabase(ctx.db, async (tx) => {
      await getDb(tx)
        .select()
        .from(run)
        .where(eq(run.id, seeded.runId))
        .for("no key update");
      held.resolve();
      await release.promise;
    });
    await held.promise;
    let targets;
    try {
      targets = await claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id);
    } finally {
      release.resolve();
      await progress;
    }
    expect(targets).toHaveLength(4);
    expect(await finish(targets!)).toHaveLength(4);
  });

  it("summarizes refresh progress without reading frozen inference payloads", async () => {
    const seeded = await seed(4);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "completed" })
      .where(eq(aiEvaluation.id, seeded.rows[0]!.id));
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({ state: "failed", error: "Synthetic evaluation failure" })
      .where(eq(aiEvaluation.id, seeded.rows[1]!.id));
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({
        state: "obsolete",
        receipt: { retryEvaluationId: crypto.randomUUID() },
      })
      .where(eq(aiEvaluation.id, seeded.rows[2]!.id));
    const summary = await countTestDbQueries(() =>
      readAiRefreshWorkSummary(ctx.db, seeded.runId, 2),
    );
    expect(summary.result.progress).toMatchObject({
      attempt: 2,
      selected: 3,
      completed: 1,
      failed: 1,
      queued: 1,
      obsolete: 0,
      errors: ["Synthetic evaluation failure"],
    });
    expect(summary.result.pending).toEqual([{ id: seeded.rows[3]!.id }]);
    expect(summary.result.failureText).toBe("Synthetic evaluation failure");
    expect(summary.queryCount).toBe(4);
    expect(
      summary.statements.some((statement) => statement.includes('"snapshot"')),
    ).toBe(false);
  });
  it("retires queued obsolete generations without inference and preserves paused authority", async () => {
    const seeded = await seed(2);
    const activation = await activateAiRefresh(
      ctx.db,
      "synthetic-generation-before",
      { enabled: true },
    );
    const manifest = structuredClone(activation.manifest);
    manifest["product-identity"]!.policyFingerprint += ":changed";
    await activateAiRefresh(ctx.db, "synthetic-generation-changed", {
      enabled: true,
      manifest,
    });
    await activateAiRefresh(ctx.db, "synthetic-generation-current", {
      enabled: true,
    });
    expect(await claimAiEvaluationPage(ctx.db, seeded.jobs[0]!.id)).toEqual([]);
    expect(
      (await getDb(ctx.db).select().from(aiEvaluation)).every(
        (entry) => entry.state === "obsolete",
      ),
    ).toBe(true);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.kind, "ai.evaluation"))
      ).every((entry) => entry.state === "completed"),
    ).toBe(true);
    const paused = await seed(1, "synthetic-paused-feature");
    await getDb(ctx.db)
      .update(run)
      .set({ status: "paused" })
      .where(eq(run.id, paused.runId));
    expect(await claimAiEvaluationPage(ctx.db, paused.jobs[0]!.id)).toEqual([]);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(job)
          .where(eq(job.id, paused.jobs[0]!.id))
      )[0],
    ).toMatchObject({ state: "paused", attempts: 0, leaseToken: null });
  });

  it.each(["input", "key"] as const)(
    "fails a malformed durable Job %s without stranding a fresh sibling",
    async (field) => {
      const seeded = await seed(2);
      await getDb(ctx.db)
        .update(job)
        .set(
          field === "input"
            ? { input: {} }
            : { key: "synthetic-invalid-evaluation-key" },
        )
        .where(eq(job.id, seeded.jobs[0]!.id));
      expect(
        await aiEvaluationJobHandler.advancePage(ctx.db, seeded.jobs[0]!.id),
      ).toBe("failed");
      const targets = await claimAiEvaluationPage(ctx.db, seeded.jobs[1]!.id);
      expect(targets).toHaveLength(1);
      expect(await finish(targets)).toHaveLength(1);
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(job)
            .where(eq(job.id, seeded.jobs[0]!.id))
        )[0]?.state,
      ).toBe("retry_wait");
    },
  );
});
