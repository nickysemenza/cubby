import { aiRefreshRunInput } from "@cubby/schemas/ai-evaluation";
import { runEntityId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { eq } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { compiledRefreshManifest } from "~/server/ai/refresh-policy";
import {
  aiEvaluation,
  assessmentState as suggestion,
  run,
  email,
  product,
} from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import {
  claimAiEvaluation,
  guardAiEvaluation,
} from "~/server/repo/ai-evaluation";
import {
  activateAiRefresh,
  saveAiDiscoveryCursor,
  readAiDiscoveryCursor,
} from "~/server/repo/ai-refresh";
import { reviewAssessment } from "~/server/repo/assessment-review";
import { withTransactionDatabase } from "~/server/repo/database-helpers";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { controlWorkflowRun } from "~/server/workflow-runs/control";

import {
  aiRefreshRelaunchCandidates,
  discoverAiRefresh,
  executeAiRefreshTarget,
} from "./ai-refresh";
import {
  categoryPorts,
  kernelCtx,
  productCategoryId,
  productFixture,
  seedPending,
  runCode,
  startSuggestionSweep,
} from "./suggestion-sweep.fixtures";

// Real database/publication boundaries; only the external decision model is scripted.
describe("targeted prompt refresh", () => {
  const ctx = withTestDb();
  it("spends its relaunch budget on failed or unstarted Runs instead of healthy instances", async () => {
    const item = await productFixture(ctx, "Synthetic recovery backlog");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    await activateAiRefresh(ctx.db, "synthetic-recovery-backlog", {
      enabled: true,
    });
    await discoverAiRefresh(ctx.db, {
      context: kernelCtx(ctx),
      suggestPorts: categoryPorts(0.6).suggestPorts,
    });
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.executionKind, "ai_refresh"));
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, evaluation!.runId));
    await getDb(ctx.db)
      .update(run)
      .set({
        progress: {
          attempt: 1,
          selected: 1,
          completed: 0,
          blocked: 0,
          failed: 0,
        },
      })
      .where(eq(run.id, owner!.id));
    const siblings = Array.from({ length: 30 }, () => ({
      ...owner!,
      id: runEntityId.parse(crypto.randomUUID()),
      shortcode: generateShortcode("run"),
      clientKey: null,
      progress: {
        attempt: 1,
        selected: 1,
        completed: 0,
        blocked: 0,
        failed: 0,
      },
    }));
    await getDb(ctx.db).insert(run).values(siblings);
    await getDb(ctx.db)
      .insert(aiEvaluation)
      .values(
        siblings.map((row) => ({
          ...evaluation!,
          id: crypto.randomUUID(),
          runId: row.id,
          workKey: `synthetic-backlog:${row.id}`,
        })),
      );
    const failedStatus: typeof run.$inferInsert.status = "failed";
    const failed = {
      ...owner!,
      id: runEntityId.parse(crypto.randomUUID()),
      shortcode: generateShortcode("run"),
      clientKey: null,
      status: failedStatus,
      progress: {
        attempt: 1,
        selected: 1,
        completed: 0,
        blocked: 0,
        failed: 0,
      },
      updatedAt: new Date(),
    };
    await getDb(ctx.db).insert(run).values(failed);
    await getDb(ctx.db)
      .insert(aiEvaluation)
      .values({
        ...evaluation!,
        id: crypto.randomUUID(),
        runId: failed.id,
        workKey: `synthetic-recovery:${failed.id}`,
      });
    expect(
      (await aiRefreshRelaunchCandidates(ctx.db)).map((row) => row.id),
    ).toEqual([failed.id]);
  });

  it("advances discovery past a broken roster and schedules another eligible target", async () => {
    const broken = await productFixture(ctx, "Synthetic broken roster");
    const healthy = await productFixture(ctx, "Synthetic healthy roster");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [broken.id, healthy.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    await activateAiRefresh(ctx.db, "synthetic-isolated-discovery", {
      enabled: true,
    });
    const base = categoryPorts(0.6).suggestPorts;
    const spec = base.registry["product.categoryId"];
    const runs = await discoverAiRefresh(ctx.db, {
      context: kernelCtx(ctx),
      suggestPorts: {
        ...base,
        registry: {
          "product.categoryId": {
            ...spec,
            roster: async (...args: Parameters<typeof spec.roster>) => {
              if (args[1].name === "Synthetic broken roster")
                throw new Error("Synthetic roster failure");
              return spec.roster(...args);
            },
          },
        },
      },
    });
    expect(runs).toHaveLength(1);
    const rows = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.executionKind, "ai_refresh"));
    expect(rows).toHaveLength(1);
    const [stored] = await getDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(eq(product.name, "Synthetic healthy roster"));
    expect(rows[0]?.target.recordId).toBe(stored!.id);
  });

  it("deduplicates triggers and preserves a pending proposal rejected while inference was outstanding", async () => {
    const item = await productFixture(ctx, "Synthetic refresh product");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    await activateAiRefresh(ctx.db, "synthetic-release", { enabled: true });
    const ports = {
      context: kernelCtx(ctx),
      suggestPorts: categoryPorts().suggestPorts,
    };
    await discoverAiRefresh(ctx.db, ports);
    await discoverAiRefresh(ctx.db, ports);
    const evaluations = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.executionKind, "ai_refresh"));
    expect(evaluations).toHaveLength(1);
    const [pending] = await getDb(ctx.db)
      .select()
      .from(suggestion)
      .where(eq(suggestion.status, "pending"));
    expect(pending).toBeDefined();
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: pending!.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "history",
    });
    await executeAiRefreshTarget(ctx.db, evaluations[0]!.id, ports);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(suggestion)
          .where(eq(suggestion.id, pending!.id))
      )[0]?.status,
    ).toBe("rejected");
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestion)
        .where(eq(suggestion.status, "pending")),
    ).toHaveLength(0);
  });
  it("refreshes unknown pending provenance once, retains history and audits confident automatic acceptance", async () => {
    const item = await productFixture(ctx, "Synthetic legacy product");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    await getDb(ctx.db).update(suggestion).set({ provenance: null });
    await activateAiRefresh(ctx.db, "synthetic-current", { enabled: true });
    const ports = {
      context: kernelCtx(ctx),
      suggestPorts: categoryPorts(0.95).suggestPorts,
    };
    await discoverAiRefresh(ctx.db, ports);
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.executionKind, "ai_refresh"));
    await executeAiRefreshTarget(ctx.db, evaluation!.id, ports);
    const history = await getDb(ctx.db).select().from(suggestion);
    expect(history.map((row) => row.status).sort()).toEqual([
      "applied",
      "superseded",
    ]);
    const applied = history.find((row) => row.status === "applied")!;
    expect(applied.evaluationId).toBe(evaluation!.id);
    expect(applied.acceptanceReceipt).toMatchObject({
      mode: "automatic",
      runId: evaluation!.runId,
    });
    expect(applied.acceptanceReceipt!.auditIds.length).toBeGreaterThan(0);
    expect(await productCategoryId(ctx.db, item.id)).toBe(taxonomyId("food"));
    expect(await discoverAiRefresh(ctx.db, ports)).toEqual([]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.executionKind, "ai_refresh")),
    ).toHaveLength(1);
  });

  it("fences an old result on rollback while leaving unrelated feature generations alone", async () => {
    const item = await productFixture(ctx, "Synthetic version product");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    const manifest = await compiledRefreshManifest();
    const active = await activateAiRefresh(ctx.db, "synthetic-a", {
      enabled: true,
      manifest,
    });
    const ports = {
      context: kernelCtx(ctx),
      suggestPorts: categoryPorts(0.6).suggestPorts,
    };
    await discoverAiRefresh(ctx.db, ports);
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.executionKind, "ai_refresh"));
    const claimed = await claimAiEvaluation(ctx.db, evaluation!.id);
    const changed = {
      ...manifest,
      "field-suggestion": {
        ...manifest["field-suggestion"]!,
        promptVersion: "synthetic-next",
      },
    };
    const next = await activateAiRefresh(ctx.db, "synthetic-b", {
      enabled: true,
      manifest: changed,
    });
    expect(next.manifest["mailbox-triage"]).toEqual(
      active.manifest["mailbox-triage"],
    );
    const rollback = await activateAiRefresh(ctx.db, "synthetic-rollback", {
      enabled: true,
      manifest,
    });
    expect(rollback.manifest["field-suggestion"]!.generation).toBe(
      active.manifest["field-suggestion"]!.generation + 2,
    );
    await expect(
      withTransactionDatabase(ctx.db, (tx) =>
        guardAiEvaluation(tx, evaluation!.id, claimed!.attemptToken!),
      ),
    ).rejects.toThrow("obsolete");
    expect((await getDb(ctx.db).select().from(suggestion))[0]?.status).toBe(
      "pending",
    );
  });

  it("resumes a saved result with a new attempt token without reinference and caps global active targets at two", async () => {
    const item = await productFixture(ctx, "Synthetic resume product");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    await activateAiRefresh(ctx.db, "synthetic-resume", { enabled: true });
    const ports = {
      context: kernelCtx(ctx),
      suggestPorts: categoryPorts(0.6).suggestPorts,
    };
    await discoverAiRefresh(ctx.db, ports);
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.executionKind, "ai_refresh"));
    const otherIds = [crypto.randomUUID(), crypto.randomUUID()];
    for (const id of otherIds)
      await getDb(ctx.db)
        .insert(aiEvaluation)
        .values({
          id,
          runId: evaluation!.runId,
          workKey: `synthetic:${id}`,
          feature: evaluation!.feature,
          target: evaluation!.target,
          provenance: evaluation!.provenance,
          snapshot: evaluation!.snapshot,
        });
    const first = await claimAiEvaluation(ctx.db, evaluation!.id);
    expect(await claimAiEvaluation(ctx.db, otherIds[0]!)).not.toBeNull();
    expect(await claimAiEvaluation(ctx.db, otherIds[1]!)).toBeNull();
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({
        state: "result_ready",
        result: { saved: true },
        deadlineAt: new Date(0),
      })
      .where(eq(aiEvaluation.id, evaluation!.id));
    await getDb(ctx.db)
      .update(run)
      .set({
        progress: {
          attempt: 2,
          selected: 3,
          completed: 0,
          blocked: 0,
          failed: 0,
        },
      })
      .where(eq(run.id, evaluation!.runId));
    const resumed = await claimAiEvaluation(ctx.db, evaluation!.id);
    expect(resumed?.attemptToken).not.toBe(first!.attemptToken);
    expect(resumed?.runAttempt).toBe(2);
    expect(resumed?.attempts).toBe(1);
    expect(resumed?.result).toEqual({ saved: true });
    await expect(
      withTransactionDatabase(ctx.db, (tx) =>
        guardAiEvaluation(tx, evaluation!.id, first!.attemptToken!),
      ),
    ).rejects.toThrow("obsolete");
  });

  it("freezes 201 eligible Emails into 200-item Runs, reports missing authorization and leaves confident decisions alone", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic refresh member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await getDb(ctx.db)
      .insert(email)
      .values(
        Array.from({ length: 201 }, (_, i) => ({
          shortcode: generateShortcode("email"),
          ledgerPartyId: party.id,
          mailboxId: "synthetic-refresh-mailbox",
          messageId: `synthetic-message-${i}`,
          checksum: `synthetic-checksum-${i}`,
          classification: "uncertain",
          classificationStage: "decision",
          classificationReason: "Synthetic ambiguity",
          status: "pending",
        })),
      );
    const confident = await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-refresh-mailbox",
      messageId: "synthetic-confident-message",
      checksum: "synthetic-confident-checksum",
      classification: "unrelated",
      classificationStage: "decision",
      classificationReason: "Synthetic confident verdict",
      status: "pending",
    });
    await activateAiRefresh(ctx.db, "synthetic-mail-refresh", {
      enabled: true,
    });
    expect(await discoverAiRefresh(ctx.db)).toEqual([]);
    const runs = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "ai_refresh"));
    expect(
      runs
        .map((row) => aiRefreshRunInput.parse(row.input).emails!.length)
        .sort((a, b) => a - b),
    ).toEqual([1, 200]);
    const evaluations = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.executionKind, "ai_refresh"));
    expect(evaluations).toHaveLength(201);
    expect(evaluations.every((row) => row.state === "blocked")).toBe(true);
    expect(
      evaluations.some((row) => row.target.recordId === confident.id),
    ).toBe(false);
    await discoverAiRefresh(ctx.db);
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.executionKind, "ai_refresh")),
    ).toHaveLength(201);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(email)
          .where(eq(email.id, confident.id))
      )[0]?.classification,
    ).toBe("unrelated");
  });

  it("keeps no-evidence completion terminal until the relevant input changes", async () => {
    const item = await productFixture(ctx, "Synthetic evidence product");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    await activateAiRefresh(ctx.db, "synthetic-evidence", { enabled: true });
    const ordinary = categoryPorts().suggestPorts;
    const ports = {
      context: kernelCtx(ctx),
      suggestPorts: {
        ...ordinary,
        registry: {
          "product.categoryId": {
            ...ordinary.registry["product.categoryId"],
            roster: async () => [],
          },
        },
      },
    };
    await discoverAiRefresh(ctx.db, ports);
    const [first] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.executionKind, "ai_refresh"));
    await executeAiRefreshTarget(ctx.db, first!.id, ports);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.executionKind, "ai_refresh"))
      )[0]?.state,
    ).toBe("completed");
    expect(
      (await getDb(ctx.db).select().from(suggestion))[0]?.supersessionReceipt
        ?.reason,
    ).toBe("no_proposal");
    await discoverAiRefresh(ctx.db, ports);
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.executionKind, "ai_refresh")),
    ).toHaveLength(1);
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic changed evidence" });
    await discoverAiRefresh(ctx.db, ports);
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.executionKind, "ai_refresh")),
    ).toHaveLength(2);
  });

  it("bounds transient reinference and preserves the same rejected semantic proposal", async () => {
    const item = await productFixture(ctx, "Synthetic retry product");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    const [original] = await getDb(ctx.db).select().from(suggestion);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: original!.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "history",
    });
    await seedPending(ctx, {
      entity: "product",
      recordId: original!.recordId,
      field: "categoryId",
      currentValue: null,
      suggestedValue: original!.suggestedValue,
      kind: "addition",
    });
    await activateAiRefresh(ctx.db, "synthetic-retry", { enabled: true });
    const ports = {
      context: kernelCtx(ctx),
      suggestPorts: categoryPorts(0.6).suggestPorts,
    };
    await discoverAiRefresh(ctx.db, ports);
    const [first] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.executionKind, "ai_refresh"));
    let physicalCalls = 0;
    const failing = {
      ...ports,
      suggestPorts: {
        ...ports.suggestPorts,
        decisionPort: async () => {
          physicalCalls++;
          throw new Error("Synthetic transient provider failure");
        },
      },
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      await getDb(ctx.db)
        .update(aiEvaluation)
        .set({ nextAttemptAt: new Date(0) });
      await executeAiRefreshTarget(ctx.db, first!.id, failing);
    }
    expect(physicalCalls).toBe(3);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.executionKind, "ai_refresh"))
      )[0]?.state,
    ).toBe("failed");
    await executeAiRefreshTarget(ctx.db, first!.id, failing);
    expect(physicalCalls).toBe(3);
    // An explicit operator retry may recover; the earlier rejected row still suppresses its candidate.
    await getDb(ctx.db)
      .update(run)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(run.id, first!.runId));
    await controlWorkflowRun(
      ctx.db,
      ctx.actor,
      { runPublicId: await runCode(ctx.db, first!.runId), action: "retry" },
      "ai_refresh",
      {
        create: async () => undefined,
        terminate: async () => undefined,
        status: async () => ({ state: "running", error: null }),
      },
    );
    const replacement = (
      await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.executionKind, "ai_refresh"))
    ).find((row) => row.id !== first!.id)!;
    await executeAiRefreshTarget(ctx.db, replacement.id, ports);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, first!.id))
      )[0]?.state,
    ).toBe("failed");
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(suggestion)
          .where(eq(suggestion.id, original!.id))
      )[0]?.status,
    ).toBe("rejected");
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestion)
        .where(eq(suggestion.status, "pending")),
    ).toHaveLength(0);
  });

  it("protects a member ABA edit while an input-invalidated no-proposal target is in flight", async () => {
    const item = await productFixture(ctx, "Synthetic ABA product");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    await activateAiRefresh(ctx.db, "synthetic-aba", { enabled: true });
    const ordinary = categoryPorts(0.95).suggestPorts;
    const empty = {
      context: kernelCtx(ctx),
      suggestPorts: {
        ...ordinary,
        registry: {
          "product.categoryId": {
            ...ordinary.registry["product.categoryId"],
            roster: async () => [],
          },
        },
      },
    };
    await discoverAiRefresh(ctx.db, empty);
    const [first] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.executionKind, "ai_refresh"));
    await executeAiRefreshTarget(ctx.db, first!.id, empty);
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic changed ABA evidence" });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ports = {
      context: kernelCtx(ctx),
      suggestPorts: {
        ...ordinary,
        decisionPort: async (
          ...args: Parameters<typeof ordinary.decisionPort>
        ) => {
          started.resolve();
          await release.promise;
          return ordinary.decisionPort(...args);
        },
      },
    };
    await discoverAiRefresh(ctx.db, ports);
    const second = (
      await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.executionKind, "ai_refresh"))
    ).find((row) => row.id !== first!.id)!;
    const outstanding = executeAiRefreshTarget(ctx.db, second.id, ports);
    await started.promise;
    for (const value of [taxonomyShortcode("food"), null])
      await executeEntity(
        kernelCtx(ctx),
        entityCommandSchema.parse({
          action: "update",
          entity: "product",
          id: item.id,
          data: { categoryId: value },
        }),
      );
    release.resolve();
    await outstanding;
    expect(await productCategoryId(ctx.db, item.id)).toBeNull();
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, second.id))
      )[0]?.state,
    ).toBe("obsolete");
    expect(
      await getDb(ctx.db)
        .select()
        .from(suggestion)
        .where(eq(suggestion.status, "applied")),
    ).toHaveLength(0);
    expect(await discoverAiRefresh(ctx.db, ports)).toEqual([]);
  });
  it("does not restart a finished field scan while the Email stream still has pages", async () => {
    const item = await productFixture(ctx, "Synthetic completed scan stream");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    const activation = await activateAiRefresh(ctx.db, "synthetic-scan", {
      enabled: true,
    });
    await saveAiDiscoveryCursor(ctx.db, {
      revision: activation.revision,
      field: null,
      fieldDone: true,
      email: "00000000-0000-4000-8000-000000000123",
      emailDone: false,
    });
    expect(
      await discoverAiRefresh(ctx.db, {
        context: kernelCtx(ctx),
        suggestPorts: categoryPorts(0.6).suggestPorts,
      }),
    ).toEqual([]);
    expect(await readAiDiscoveryCursor(ctx.db)).toMatchObject({
      fieldDone: true,
      emailDone: true,
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.executionKind, "ai_refresh")),
    ).toHaveLength(0);
  });
});
