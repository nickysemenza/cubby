import {
  aiRefreshRunInput,
  aiEvaluationTarget,
  aiProvenance,
  suggestionAcceptanceReceipt,
} from "@cubby/schemas/ai-evaluation";
import { assessmentFamily } from "@cubby/schemas/assessment";
import { runEntityId } from "@cubby/schemas/identifiers";
import { generateShortcode } from "@cubby/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import {
  dependencyStamps,
  fieldDependencyKeys,
  compiledRefreshManifest,
} from "~/server/ai/policy/refresh-manifest";
import {
  claimAiEvaluation,
  guardAiEvaluation,
  publishAiEvaluation,
} from "~/server/ai/repo/ai-evaluation";
import {
  producingAiManifest,
  activateAiRefresh,
  saveAiDiscoveryCursor,
  readAiDiscoveryCursor,
} from "~/server/ai/repo/ai-refresh";
import { withTransactionDatabase } from "~/server/db/helpers";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  assessmentState as suggestion,
  run,
  email,
  product,
  appSettings,
  feedback,
} from "~/server/db/schema";
import { setMailImport } from "~/server/domains/purchase-import/repo/mail-import-settings";
import { inferFieldAssessments } from "~/server/domains/run/operations/ai.server";
import { writeRunningAttemptProgress } from "~/server/domains/run/repo/ai-work-state";
import { ensureRun, systemActor } from "~/server/domains/run/repo/ensure-run";
import { executeEntity } from "~/server/entity-kernel";
import { entityCommandSchema } from "~/server/entity-kernel/contracts";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import {
  acceptSuggestion,
  canAutomaticallyFillField,
} from "~/server/generic/assessment/repo/suggestion-review";
import { reconcileDerivedRefreshPage } from "~/server/generic/derived-refresh/repo/reconcile";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { settleDerivedRefreshForDiscovery } from "~/server/testing/background-queue";
import {
  createProductFixture,
  makeProductInput,
  createSystemUserFixture,
} from "~/server/testing/repo.fixtures";
import { controlWorkflowRun } from "~/server/workflows/runs/control";

import { aiRefreshRelaunchCandidates } from "../repo/ai-refresh-state";
import { scheduleConnectionRefresh } from "../repo/connection-refresh";
import { discoverAiRefresh, executeAiRefreshTarget } from "./ai-refresh";
import {
  categoryPorts,
  PRIMARY_MODEL,
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
  const emailTarget = aiEvaluationTarget.options.find(
    (target) => target.shape.kind.value === "email",
  )!;
  beforeEach(() => createSystemUserFixture(ctx.db));
  const fieldTarget = aiEvaluationTarget.options.find(
    (target) => target.shape.kind.value === "field",
  )!;
  const fieldRefreshTarget = and(
    eq(aiEvaluation.executionKind, "ai_refresh"),
    sql`${aiEvaluation.target}->>${fieldTarget.keyof().enum.kind} = ${fieldTarget.shape.kind.value}`,
  );
  const emailRefreshTarget = and(
    eq(aiEvaluation.executionKind, "ai_refresh"),
    sql`${aiEvaluation.target}->>${emailTarget.keyof().enum.kind} = ${emailTarget.shape.kind.value}`,
  );
  async function discoverFieldRefresh(
    ports: Parameters<typeof discoverAiRefresh>[1],
  ) {
    const { runs: discovered } = await discoverAiRefresh(ctx.db, ports);
    const targets = await getDb(ctx.db)
      .select({ runId: aiEvaluation.runId })
      .from(aiEvaluation)
      .where(fieldRefreshTarget);
    return discovered.filter((id) =>
      targets.some((target) => target.runId === id),
    );
  }
  // Failure: unchanged pending backlog is skipped forever; a saved clear or
  // populated value is overwritten; replay applies the same advice twice.
  it.each(["empty", "cleared", "populated"] as const)(
    "reconsiders retained high-confidence backlog while preserving %s intent",
    async (state) => {
      const item = await productFixture(ctx, "Synthetic backlog product");
      const [subject] = await getDb(ctx.db)
        .select({ id: product.id })
        .from(product)
        .where(eq(product.shortcode, item.id));
      if (!subject) throw new Error("Synthetic backlog subject missing");
      if (state !== "empty") {
        await executeEntity(kernelCtx(ctx), {
          action: "update",
          entity: "product",
          id: item.id,
          data: { categoryId: taxonomyShortcode("tools") },
        });
        if (state === "cleared")
          await executeEntity(kernelCtx(ctx), {
            action: "update",
            entity: "product",
            id: item.id,
            data: { categoryId: null },
          });
      }
      const pending = await seedPending(ctx, {
        entity: "product",
        recordId: subject.id,
        field: "categoryId",
        currentValue: state === "populated" ? taxonomyId("tools") : null,
        suggestedValue: taxonomyShortcode("food"),
        kind: state === "populated" ? "correction" : "addition",
      });
      await activateAiRefresh(ctx.db, "synthetic-backlog-policy", {
        enabled: true,
      });
      await getDb(ctx.db)
        .update(suggestion)
        .set({
          confidence: 0.97,
          provenance: {
            dependencies: dependencyStamps(
              await producingAiManifest(ctx.db),
              fieldDependencyKeys("product", "categoryId"),
            ),
            inputFingerprint: "synthetic",
            optionFingerprint: "synthetic",
            model: PRIMARY_MODEL,
          },
        })
        .where(eq(suggestion.id, pending.id));
      const ports = {
        context: kernelCtx(ctx),
        suggestPorts: categoryPorts().suggestPorts,
      };
      await discoverAiRefresh(ctx.db, ports);
      await discoverAiRefresh(ctx.db, ports);
      const [saved] = await getDb(ctx.db)
        .select()
        .from(suggestion)
        .where(eq(suggestion.id, pending.id));
      const [live] = await getDb(ctx.db)
        .select({ categoryId: product.categoryId })
        .from(product)
        .where(eq(product.id, subject.id));
      expect(saved?.status).toBe(state === "empty" ? "applied" : "pending");
      expect(live?.categoryId).toBe(
        state === "empty"
          ? taxonomyId("food")
          : state === "cleared"
            ? null
            : taxonomyId("tools"),
      );
    },
  );

  // Failure: backlog applies stale advice before discovery checks AI policy provenance.
  it.each(["missing", "incomplete", "stale"] as const)(
    "reinfers %s provenance before automatic backlog acceptance",
    async (state) => {
      const item = await productFixture(ctx, "Synthetic stale backlog");
      const [subject] = await getDb(ctx.db)
        .select()
        .from(product)
        .where(eq(product.shortcode, item.id));
      const pending = await seedPending(ctx, {
        entity: "product",
        recordId: subject!.id,
        field: "categoryId",
        currentValue: null,
        suggestedValue: taxonomyShortcode("tools"),
        kind: "addition",
      });
      const dependencies = dependencyStamps(
        await producingAiManifest(ctx.db),
        fieldDependencyKeys("product", "categoryId"),
      );
      await getDb(ctx.db)
        .update(suggestion)
        .set({
          confidence: 0.97,
          provenance:
            state === "missing"
              ? null
              : {
                  dependencies:
                    state === "incomplete"
                      ? dependencies.slice(0, 1)
                      : dependencies.map((stamp) => ({
                          ...stamp,
                          policyFingerprint: "synthetic-stale-policy",
                        })),
                  inputFingerprint: "synthetic",
                  optionFingerprint: "synthetic",
                  model: PRIMARY_MODEL,
                },
        })
        .where(eq(suggestion.id, pending.id));
      expect(
        await canAutomaticallyFillField(ctx.db, kernelCtx(ctx), pending.id),
      ).toBe(false);
      await expect(
        acceptSuggestion(
          ctx.db,
          kernelCtx(ctx),
          { id: pending.id },
          { mode: "automatic", confidence: 0.97 },
        ),
      ).rejects.toThrow(/provenance/);
      expect(await productCategoryId(ctx.db, item.id)).toBeNull();
      await activateAiRefresh(ctx.db, "synthetic-provenance-refresh", {
        enabled: true,
      });
      const ports = {
        context: kernelCtx(ctx),
        suggestPorts: categoryPorts(0.97).suggestPorts,
        auditSample: () => false,
      };
      await discoverAiRefresh(ctx.db, ports);
      expect(await productCategoryId(ctx.db, item.id)).toBeNull();
      const [evaluation] = await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(fieldRefreshTarget);
      await executeAiRefreshTarget(ctx.db, evaluation!.id, ports);
      expect(await productCategoryId(ctx.db, item.id)).toBe(taxonomyId("food"));
      const history = await getDb(ctx.db)
        .select()
        .from(suggestion)
        .where(eq(suggestion.recordId, subject!.id));
      expect(history.find((row) => row.id === pending.id)?.status).toBe(
        "superseded",
      );
      expect(
        history.find((row) => row.status === "applied")?.evaluationId,
      ).toBe(evaluation!.id);
    },
  );

  // Failure: saved-record list questions publish only inactive live predictions,
  // or a client draft becomes the automatic write's authoritative snapshot.
  it("schedules saved live questions from canonical data while drafts stay interactive", async () => {
    const item = await productFixture(ctx, "Synthetic canonical groceries");
    await activateAiRefresh(ctx.db, "synthetic-live-question", {
      enabled: true,
      startDiscovery: false,
    });
    const ports = {
      context: kernelCtx(ctx),
      suggestPorts: categoryPorts(0.97).suggestPorts,
      auditSample: () => false,
    };
    const draft = {
      entity: "product" as const,
      basisMode: "suggested" as const,
      targets: ["categoryId"],
      basis: { name: "Synthetic client-only draft", categoryId: null },
    };
    await inferFieldAssessments(kernelCtx(ctx), draft, ports.suggestPorts);
    await inferFieldAssessments(
      kernelCtx(ctx),
      { ...draft, entityId: item.id, basisMode: "provided", savedRecord: true },
      ports.suggestPorts,
    );
    await inferFieldAssessments(
      kernelCtx(ctx),
      { ...draft, entityId: item.id },
      ports.suggestPorts,
    );
    expect(
      await getDb(ctx.db).select().from(aiEvaluation).where(fieldRefreshTarget),
    ).toEqual([]);
    await inferFieldAssessments(
      kernelCtx(ctx),
      { ...draft, entityId: item.id, savedRecord: true },
      ports.suggestPorts,
    );
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(fieldRefreshTarget);
    expect(evaluation?.snapshot).toMatchObject({
      basis: { name: "Synthetic canonical groceries" },
    });
    expect(await productCategoryId(ctx.db, item.id)).toBeNull();
    await executeAiRefreshTarget(ctx.db, evaluation!.id, ports);
    expect(await productCategoryId(ctx.db, item.id)).toBe(taxonomyId("food"));
    await inferFieldAssessments(
      kernelCtx(ctx),
      { ...draft, entityId: item.id, savedRecord: true },
      ports.suggestPorts,
    );
    expect(
      await getDb(ctx.db).select().from(aiEvaluation).where(fieldRefreshTarget),
    ).toHaveLength(1);
  });

  // A two-target inference cap cannot bound one Workflow/Run per catalog record.
  it("joins Product discovery targets to one active refresh Run across repeated passes", async () => {
    await productFixture(ctx, "Synthetic refresh hammer");
    await productFixture(ctx, "Synthetic refresh drill");
    await productFixture(ctx, "Synthetic refresh saw");
    await activateAiRefresh(ctx.db, "synthetic-shared-discovery", {
      enabled: true,
    });
    await discoverAiRefresh(ctx.db);
    await discoverAiRefresh(ctx.db);
    const evaluations = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.feature, "product-identity"));
    expect(evaluations).toHaveLength(3);
    expect(new Set(evaluations.map((row) => row.runId)).size).toBe(1);
    const owners = await getDb(ctx.db)
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.purpose, "ai_refresh"), eq(run.status, "running")));
    expect(owners).toHaveLength(1);
  });

  it("retains the discovery cursor while execution slots are full and covers deferred Products later", async () => {
    const item = await productFixture(ctx, "Synthetic deferred Product");
    const activation = await activateAiRefresh(
      ctx.db,
      "synthetic-deferred-discovery",
      { enabled: true },
    );
    const owners = [];
    for (let index = 0; index < 2; index++)
      owners.push(
        await ensureRun(ctx.db, systemActor(), {
          purpose: "ai_refresh",
          trigger: "scheduled",
          status: "running",
          input: aiRefreshRunInput.parse({
            kind: "ai_refresh",
            mailboxId: `synthetic-busy-${index}`,
            activation,
          }),
        }),
      );
    await discoverAiRefresh(ctx.db);
    expect(await readAiDiscoveryCursor(ctx.db)).toMatchObject({
      productDone: false,
      product: null,
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(eq(aiEvaluation.feature, "product-identity")),
    ).toHaveLength(0);
    await getDb(ctx.db)
      .update(run)
      .set({ status: "completed", endedAt: new Date() })
      .where(eq(run.id, owners[0]!));
    await discoverAiRefresh(ctx.db);
    expect(await readAiDiscoveryCursor(ctx.db)).toMatchObject({
      productDone: true,
    });
    const [stored] = await getDb(ctx.db)
      .select({ id: product.id })
      .from(product)
      .where(eq(product.shortcode, item.id));
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.feature, "product-identity"))
      )[0]?.target.recordId,
    ).toBe(stored!.id);
  });

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
      .where(fieldRefreshTarget);
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
      .where(eq(run.purpose, "ai_refresh"));
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
    const runs = await discoverFieldRefresh({
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
      .where(fieldRefreshTarget);
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
      .where(fieldRefreshTarget);
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
      // The default sampler holds a deterministic 5% of random record ids for review.
      auditSample: () => false,
    };
    await discoverAiRefresh(ctx.db, ports);
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(fieldRefreshTarget);
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
    expect(await discoverFieldRefresh(ports)).toEqual([]);
    expect(
      await getDb(ctx.db).select().from(aiEvaluation).where(fieldRefreshTarget),
    ).toHaveLength(1);
  });

  // Failure modes: applied/inactive saved-form targets and rejected corrections
  // with retained application receipts disappear from discovery;
  // their original value or a later member write permanently vetoes reevaluation;
  // a new policy rewrites their immutable receipts, or each application reinfers.
  it.each(["accepted", "corrected"])(
    "reopens an applied inactive target after policy change using the current member value and then skips unchanged evidence (%s)",
    async (state) => {
      const item = await productFixture(
        ctx,
        "Synthetic saved-form policy product",
      );
      const oldManifest = await compiledRefreshManifest();
      oldManifest["field:product.categoryId"]!.policyFingerprint =
        "synthetic-old-assignment-policy";
      await activateAiRefresh(ctx.db, "synthetic-before-assignment", {
        enabled: true,
        manifest: oldManifest,
      });
      await startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          fields: ["categoryId"],
          filters: { ids: [item.id] },
        },
        {
          context: kernelCtx(ctx),
          ...categoryPorts(state === "corrected" ? 0.6 : 0.95),
        },
      );
      const [initial] = await getDb(ctx.db).select().from(suggestion);
      expect(initial!.status).toBe(
        state === "corrected" ? "pending" : "applied",
      );
      if (state === "corrected") {
        await reviewAssessment(ctx.db, kernelCtx(ctx), {
          assessmentId: initial!.id,
          operationId: crypto.randomUUID(),
          verdict: "wrong",
          correction: { present: true, value: taxonomyShortcode("tools") },
          intent: "apply",
        });
      }
      const [original] = await getDb(ctx.db).select().from(suggestion);
      expect(original!.status).toBe(
        state === "corrected" ? "rejected" : "applied",
      );
      expect(original!.acceptanceReceipt).toMatchObject({
        reason:
          state === "corrected" ? "member_correction" : "confident_assignment",
        appliedInputFingerprint: expect.any(String),
      });
      expect(await productCategoryId(ctx.db, item.id)).toBe(
        taxonomyId(state === "corrected" ? "tools" : "food"),
      );
      await getDb(ctx.db)
        .update(suggestion)
        .set({ active: false })
        .where(eq(suggestion.id, original!.id));
      await executeEntity(
        kernelCtx(ctx),
        entityCommandSchema.parse({
          action: "update",
          entity: "product",
          id: item.id,
          data: { categoryId: taxonomyShortcode("tools") },
        }),
      );
      const changed = await compiledRefreshManifest();
      await activateAiRefresh(ctx.db, "synthetic-after-assignment", {
        enabled: true,
        manifest: changed,
      });
      let calls = 0;
      const ordinary = categoryPorts(0.95).suggestPorts;
      const ports = {
        context: kernelCtx(ctx),
        auditSample: () => false,
        suggestPorts: {
          ...ordinary,
          decisionModel: PRIMARY_MODEL,
          decisionPort: async (
            ...args: Parameters<typeof ordinary.decisionPort>
          ) => {
            calls++;
            return ordinary.decisionPort(...args);
          },
        },
      };
      await discoverAiRefresh(ctx.db, ports);
      const [evaluation] = await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(fieldRefreshTarget);
      expect(evaluation).toBeDefined();
      await executeAiRefreshTarget(ctx.db, evaluation!.id, ports);
      expect(await productCategoryId(ctx.db, item.id)).toBe(
        taxonomyId("tools"),
      );
      const [replacement] = await getDb(ctx.db)
        .select()
        .from(suggestion)
        .where(eq(suggestion.status, "pending"));
      expect(replacement).toMatchObject({
        kind: "correction",
        acceptanceReceipt: null,
      });
      expect(calls).toBe(1);
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(suggestion)
            .where(eq(suggestion.id, original!.id))
        )[0],
      ).toMatchObject({
        status: original!.status,
        active: false,
        acceptanceReceipt: original!.acceptanceReceipt,
      });
      for (let pass = 0; pass < 3; pass++)
        expect(await discoverFieldRefresh(ports)).toEqual([]);
      expect(
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(fieldRefreshTarget),
      ).toHaveLength(1);
      expect(calls).toBe(1);
    },
  );

  // Retained applications outlive subjects and must not become recurring errors.
  it("quietly skips a deleted subject with a retained applied receipt", async () => {
    const item = await productFixture(
      ctx,
      "Synthetic deleted assignment subject",
    );
    await activateAiRefresh(ctx.db, "synthetic-deleted-assignment", {
      enabled: true,
    });
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.95) },
    );
    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.shortcode, item.id));
    const errors = vi.spyOn(console, "error");
    try {
      expect(
        await discoverFieldRefresh({
          context: kernelCtx(ctx),
          ...categoryPorts(0.95),
        }),
      ).toEqual([]);
      expect(errors).not.toHaveBeenCalledWith(
        "[ai-refresh] Field refresh discovery failed",
        expect.anything(),
      );
    } finally {
      errors.mockRestore();
    }
  });

  // Reconciliation can advance revisions after an application. An agreeing
  // evaluation must settle that basis rather than re-prepare it every cycle.
  it.each([false, true])(
    "settles an agreeing applied-field refresh after reconciliation without repeating evidence preparation (legacy receipt: %s)",
    async (legacy) => {
      const item = await productFixture(ctx, "Synthetic reconciled assignment");
      await activateAiRefresh(ctx.db, "synthetic-reconciled-assignment", {
        enabled: true,
      });
      await startSuggestionSweep(
        ctx.db,
        {
          entity: "product",
          fields: ["categoryId"],
          filters: { ids: [item.id] },
        },
        { context: kernelCtx(ctx), ...categoryPorts(0.95) },
      );
      if (legacy) {
        const [applied] = await getDb(ctx.db).select().from(suggestion);
        await getDb(ctx.db)
          .update(suggestion)
          .set({
            provenance: null,
            acceptanceReceipt: suggestionAcceptanceReceipt
              .omit({ appliedInputFingerprint: true })
              .parse(applied!.acceptanceReceipt),
          })
          .where(eq(suggestion.id, applied!.id));
      }
      let complete = false;
      for (let page = 0; page < 2_000; page++) {
        if ((await reconcileDerivedRefreshPage(ctx.db)).done) {
          complete = true;
          break;
        }
      }
      expect(complete).toBe(true);
      await settleDerivedRefreshForDiscovery(ctx.db);
      const ports = { context: kernelCtx(ctx), ...categoryPorts(0.95) };
      await discoverFieldRefresh(ports);
      const [evaluation] = await getDb(ctx.db)
        .select()
        .from(aiEvaluation)
        .where(fieldRefreshTarget);
      expect(evaluation).toBeDefined();
      await executeAiRefreshTarget(ctx.db, evaluation!.id, ports);
      const measured = await countTestDbQueries(async () => {
        for (let pass = 0; pass < 3; pass++)
          expect(await discoverFieldRefresh(ports)).toEqual([]);
      });
      expect(measured.tables).not.toContain("AuditLog");
      expect(await productCategoryId(ctx.db, item.id)).toBe(taxonomyId("food"));
    },
  );

  // Failure mode: a reviewed-wrong proposal publishes no replacement, leaving
  // its legacy applied predecessor preparing unchanged evidence every cycle.
  it("settles a legacy applied predecessor when an exact wrong review filters every refresh proposal", async () => {
    const item = await productFixture(
      ctx,
      "Synthetic reviewed refresh product",
    );
    await activateAiRefresh(ctx.db, "synthetic-reviewed-refresh", {
      enabled: true,
    });
    const input = {
      entity: "product",
      fields: ["categoryId"],
      filters: { ids: [item.id] },
    } satisfies Parameters<typeof startSuggestionSweep>[1];
    await startSuggestionSweep(ctx.db, input, {
      context: kernelCtx(ctx),
      ...categoryPorts(0.95),
    });
    const [applied] = await getDb(ctx.db).select().from(suggestion);
    expect(applied!.status).toBe("applied");
    const legacyReceipt = suggestionAcceptanceReceipt
      .omit({ appliedInputFingerprint: true })
      .parse(applied!.acceptanceReceipt);
    await getDb(ctx.db)
      .update(suggestion)
      .set({
        active: false,
        provenance: null,
        acceptanceReceipt: legacyReceipt,
      })
      .where(eq(suggestion.id, applied!.id));
    await executeEntity(
      kernelCtx(ctx),
      entityCommandSchema.parse({
        action: "update",
        entity: "product",
        id: item.id,
        data: { categoryId: taxonomyShortcode("tools") },
      }),
    );
    await startSuggestionSweep(ctx.db, input, {
      context: kernelCtx(ctx),
      ...categoryPorts(0.6),
    });
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
    await settleDerivedRefreshForDiscovery(ctx.db);
    const historicalFeedback = await getDb(ctx.db)
      .select()
      .from(feedback)
      .orderBy(feedback.id);
    const ordinary = categoryPorts(0.6).suggestPorts;
    const decisionPort = vi.fn(ordinary.decisionPort);
    const ports = {
      context: kernelCtx(ctx),
      auditSample: () => false,
      suggestPorts: { ...ordinary, decisionModel: PRIMARY_MODEL, decisionPort },
    };
    await discoverFieldRefresh(ports);
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(fieldRefreshTarget);
    expect(evaluation).toBeDefined();
    await executeAiRefreshTarget(ctx.db, evaluation!.id, ports);
    expect(decisionPort).toHaveBeenCalledTimes(1);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, evaluation!.id))
      )[0],
    ).toMatchObject({ state: "completed", receipt: { outcome: "settled" } });
    expect(await productCategoryId(ctx.db, item.id)).toBe(taxonomyId("tools"));
    const rows = await getDb(ctx.db).select().from(suggestion);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === pending!.id)?.status).toBe("rejected");
    expect(rows.find((row) => row.id === applied!.id)).toMatchObject({
      active: false,
      status: "applied",
      provenance: null,
      acceptanceReceipt: {
        ...legacyReceipt,
        evaluatedInput: {
          fingerprint: expect.any(String),
          provenance: expect.objectContaining({
            inputFingerprint: expect.any(String),
          }),
        },
      },
    });
    expect(
      await getDb(ctx.db).select().from(feedback).orderBy(feedback.id),
    ).toEqual(historicalFeedback);
    const measured = await countTestDbQueries(async () => {
      for (let pass = 0; pass < 3; pass++)
        expect(await discoverFieldRefresh(ports)).toEqual([]);
    });
    expect(measured.tables).not.toContain("AuditLog");
    expect(decisionPort).toHaveBeenCalledTimes(1);
  });

  // Failure mode: capture blesses later same-transaction member writes, even
  // when an ABA edit restores the corrected value, as the correction's inputs.
  it("rolls back a field correction followed by a member ABA edit in the same transaction", async () => {
    const item = await productFixture(ctx, "Synthetic corrected ABA product");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    const [pending] = await getDb(ctx.db).select().from(suggestion);
    expect(pending!.status).toBe("pending");
    await expect(
      withTransactionDatabase(ctx.db, async (transactionDb) => {
        const context = kernelCtx({ ...ctx, db: transactionDb });
        await reviewAssessment(transactionDb, context, {
          assessmentId: pending!.id,
          operationId: crypto.randomUUID(),
          verdict: "wrong",
          correction: { present: true, value: taxonomyShortcode("tools") },
          intent: "apply",
        });
        for (const categoryId of [
          taxonomyShortcode("household"),
          taxonomyShortcode("tools"),
        ])
          await executeEntity(
            context,
            entityCommandSchema.parse({
              action: "update",
              entity: "product",
              id: item.id,
              data: { categoryId },
            }),
          );
      }),
    ).rejects.toThrow("Derived inputs changed later in the same transaction");
    expect(await productCategoryId(ctx.db, item.id)).toBeNull();
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(suggestion)
          .where(eq(suggestion.id, pending!.id))
      )[0],
    ).toMatchObject({ status: "pending", acceptanceReceipt: null });
  });

  // Failure mode: removing historical author/value vetoes also removes the
  // current write fence and lets a correction overwrite an edit during inference.
  it("rejects a later current write while reevaluating an applied inactive target", async () => {
    const item = await productFixture(ctx, "Synthetic applied race product");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.95) },
    );
    await getDb(ctx.db)
      .update(suggestion)
      .set({ active: false, provenance: null });
    await executeEntity(
      kernelCtx(ctx),
      entityCommandSchema.parse({
        action: "update",
        entity: "product",
        id: item.id,
        data: { categoryId: taxonomyShortcode("tools") },
      }),
    );
    await activateAiRefresh(ctx.db, "synthetic-applied-race", {
      enabled: true,
    });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ordinary = categoryPorts(0.95).suggestPorts;
    const ports = {
      context: kernelCtx(ctx),
      suggestPorts: {
        ...ordinary,
        decisionModel: PRIMARY_MODEL,
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
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(fieldRefreshTarget);
    expect(evaluation).toBeDefined();
    const outstanding = executeAiRefreshTarget(ctx.db, evaluation!.id, ports);
    await started.promise;
    try {
      await executeEntity(
        kernelCtx(ctx),
        entityCommandSchema.parse({
          action: "update",
          entity: "product",
          id: item.id,
          data: { categoryId: taxonomyShortcode("household") },
        }),
      );
    } finally {
      release.resolve();
    }
    await outstanding;
    expect(await productCategoryId(ctx.db, item.id)).toBe(
      taxonomyId("household"),
    );
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, evaluation!.id))
      )[0]?.state,
    ).toBe("obsolete");
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
      .where(fieldRefreshTarget);
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

  it("publishes catalog pairs in bounded transactions with snapshot preparation outside them", async () => {
    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic catalog source" }),
      ctx.actor,
    );
    for (let index = 0; index < 4; index++)
      await createProductFixture(
        ctx.db,
        makeProductInput({
          name: `Synthetic catalog candidate ${index}`,
          aliases: ["Synthetic catalog source"],
        }),
        ctx.actor,
      );
    await activateAiRefresh(ctx.db, "synthetic-bounded-catalog", {
      enabled: true,
    });
    await discoverAiRefresh(ctx.db, { context: kernelCtx(ctx) });
    const productTarget = aiEvaluationTarget.options.find(
      (target) => target.shape.kind.value === "product",
    )!;
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(
        and(
          eq(aiEvaluation.executionKind, "ai_refresh"),
          sql`${aiEvaluation.target}->>${productTarget.keyof().enum.kind} = ${productTarget.shape.kind.value}`,
          sql`${aiEvaluation.target}->>'recordId' = ${source.entityId}`,
        ),
      );
    expect(evaluation).toBeDefined();
    await settleDerivedRefreshForDiscovery(ctx.db);
    const measured = await countTestDbQueries(() =>
      executeAiRefreshTarget(ctx.db, evaluation!.id, {
        context: kernelCtx(ctx),
      }),
    );
    expect(measured.result).toBe(true);
    let open = false,
      statements = 0,
      largest = 0;
    for (const statement of measured.statements) {
      if (/^begin\b/iu.test(statement)) {
        open = true;
        statements = 0;
      } else if (/^(commit|rollback)$/iu.test(statement)) {
        largest = Math.max(largest, statements);
        open = false;
      } else if (open) statements++;
    }
    // Pool pinning is a transaction budget, independent of catalog pair count.
    expect(largest).toBeLessThanOrEqual(35);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(eq(aiEvaluation.id, evaluation!.id))
      )[0],
    ).toMatchObject({
      state: "completed",
      receipt: { requestedPairs: 4, rulePairs: 0 },
    });
  });

  it("bounds Product connection publication transactions independently of identity pairs", async () => {
    const source = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic connection source" }),
      ctx.actor,
    );
    for (let index = 0; index < 4; index++)
      await createProductFixture(
        ctx.db,
        makeProductInput({
          name: `Synthetic connection candidate ${index}`,
          aliases: ["Synthetic connection source"],
        }),
        ctx.actor,
      );
    await activateAiRefresh(ctx.db, "synthetic-bounded-connections", {
      enabled: true,
    });
    await settleDerivedRefreshForDiscovery(ctx.db);
    const { runId } = await scheduleConnectionRefresh(
      ctx.db,
      { entityKind: "product", entityId: source.id },
      ctx.actor,
    );
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, runId!));
    expect(evaluation).toBeDefined();
    const chooseFirst: DecisionPort = async (input) => {
      const choices = Object.keys(input.questions.selection.criteria),
        choice = choices[0]!;
      return {
        answers: {
          selection: {
            type: "choice",
            choice,
            confidence: 0.7,
            probabilities: Object.fromEntries(
              choices.map((key) => [
                key,
                key === choice ? 0.7 : 0.3 / Math.max(1, choices.length - 1),
              ]),
            ),
          },
        },
      };
    };
    const measured = await countTestDbQueries(() =>
      executeAiRefreshTarget(ctx.db, evaluation!.id, {
        context: kernelCtx(ctx),
        productIdentityPorts: { decisionPort: chooseFirst },
        suggestPorts: { decisionPort: chooseFirst },
      }),
    );
    expect(measured.result).toBe(true);
    let open = false,
      statements = 0,
      largest = 0;
    for (const statement of measured.statements) {
      if (/^begin\b/iu.test(statement)) {
        open = true;
        statements = 0;
      } else if (/^(commit|rollback)$/iu.test(statement)) {
        largest = Math.max(largest, statements);
        open = false;
      } else if (open) statements++;
    }
    expect(largest).toBeLessThanOrEqual(40);
    const [savedEvaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.id, evaluation!.id));
    // Positive pairs publish without certifying an unavailable semantic roster.
    expect(savedEvaluation).toMatchObject({
      state: "retry_wait",
      error: expect.stringContaining("candidate coverage is unconfirmed"),
    });
    expect(
      await getDb(ctx.db)
        .select({ id: suggestion.id })
        .from(suggestion)
        .where(eq(suggestion.family, assessmentFamily.enum.product_pair)),
    ).toHaveLength(4);
  });

  it("leaves activation unlocked during publication work and fences deactivation before commit", async () => {
    const item = await productFixture(ctx, "Synthetic publication fence");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    await activateAiRefresh(ctx.db, "synthetic-publication-fence", {
      enabled: true,
    });
    await discoverAiRefresh(ctx.db, {
      context: kernelCtx(ctx),
      suggestPorts: categoryPorts(0.6).suggestPorts,
    });
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(fieldRefreshTarget);
    const claimed = await claimAiEvaluation(ctx.db, evaluation!.id);
    expect(claimed?.attemptToken).toBeTruthy();
    let callbackRan = false;
    const [stored] = await getDb(ctx.db)
      .select({ id: product.id, name: product.name })
      .from(product)
      .where(eq(product.name, "Synthetic publication fence"));
    expect(stored).toBeDefined();
    let probeError: unknown;
    await expect(
      publishAiEvaluation(
        ctx.db,
        evaluation!.id,
        claimed!.attemptToken!,
        async (tx) => {
          callbackRan = true;
          await getDb(tx)
            .update(product)
            .set({ name: "Synthetic tentative publication" })
            .where(eq(product.id, stored!.id));
          // A second connection must acquire activation immediately while publication is paused.
          try {
            await withTransactionDatabase(ctx.db, async (probe) => {
              await getDb(probe)
                .select({ id: appSettings.id })
                .from(appSettings)
                .for("update", { noWait: true });
              await activateAiRefresh(
                probe,
                "synthetic-disabled-during-publication",
                { enabled: false },
              );
            });
          } catch (error) {
            probeError = error;
            throw error;
          }
          return { synthetic: true };
        },
      ),
    ).rejects.toMatchObject({ cause: { code: "40001" } });
    expect(probeError).toBeUndefined();
    expect(callbackRan).toBe(true);
    expect(
      (
        await getDb(ctx.db)
          .select({ name: product.name })
          .from(product)
          .where(eq(product.id, stored!.id))
      )[0]?.name,
    ).toBe("Synthetic publication fence");
    expect(
      (await getDb(ctx.db).select().from(appSettings)).some(
        (row) => row.metadata?.enabled === false,
      ),
    ).toBe(true);
  });

  it("defers a busy admission claim without occupying a waiting connection or changing queued work", async () => {
    const item = await productFixture(ctx, "Synthetic contended refresh");
    await startSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [item.id] },
      },
      { context: kernelCtx(ctx), ...categoryPorts(0.6) },
    );
    await activateAiRefresh(ctx.db, "synthetic-contended-refresh", {
      enabled: true,
    });
    await discoverAiRefresh(ctx.db, {
      context: kernelCtx(ctx),
      suggestPorts: categoryPorts(0.6).suggestPorts,
    });
    const [evaluation] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(fieldRefreshTarget);
    expect(evaluation).toBeDefined();
    await withTransactionDatabase(ctx.db, async (holder) => {
      await getDb(holder).execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('cubby-ai-admission'))`,
      );
      await withTransactionDatabase(ctx.db, async (contender) => {
        // A blocking claim fails at the database boundary while the owner still
        // holds admission; a deferred claim returns without spending an attempt.
        await getDb(contender).execute(sql`SET LOCAL lock_timeout = '100ms'`);
        expect(await claimAiEvaluation(contender, evaluation!.id)).toBeNull();
        expect(
          (
            await getDb(contender)
              .select()
              .from(aiEvaluation)
              .where(eq(aiEvaluation.id, evaluation!.id))
          )[0],
        ).toEqual(evaluation);
      });
    });
    expect(await claimAiEvaluation(ctx.db, evaluation!.id)).not.toBeNull();
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
      .where(fieldRefreshTarget);
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
    const { runs: discovered } = await discoverAiRefresh(ctx.db);
    const emailRunIds = await getDb(ctx.db)
      .select({ runId: aiEvaluation.runId })
      .from(aiEvaluation)
      .where(emailRefreshTarget);
    expect(
      discovered.filter((id) =>
        emailRunIds.some((target) => target.runId === id),
      ),
    ).toEqual([]);
    const runs = await getDb(ctx.db)
      .select()
      .from(run)
      .where(
        inArray(
          run.id,
          emailRunIds.map(({ runId }) => runId),
        ),
      );
    expect(
      runs
        .map((row) => aiRefreshRunInput.parse(row.input).emails!.length)
        .sort((a, b) => a - b),
    ).toEqual([1, 200]);
    const evaluations = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(emailRefreshTarget);
    expect(evaluations).toHaveLength(201);
    expect(evaluations.every((row) => row.state === "blocked")).toBe(true);
    expect(
      evaluations.some((row) => row.target.recordId === confident.id),
    ).toBe(false);
    await discoverAiRefresh(ctx.db);
    expect(
      await getDb(ctx.db).select().from(aiEvaluation).where(emailRefreshTarget),
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

  it("reopens a blocked Email target under its work key once Mail import allows it", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic reopen member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    await insertWithShortcode(ctx.db, "email", {
      ledgerPartyId: party.id,
      mailboxId: "synthetic-reopen-mailbox",
      messageId: "synthetic-reopen-message",
      checksum: "synthetic-reopen-checksum",
      classification: "uncertain",
      classificationStage: "decision",
      classificationReason: "Synthetic ambiguity",
      status: "pending",
    });
    await activateAiRefresh(ctx.db, "synthetic-mail-reopen", {
      enabled: true,
    });
    await discoverAiRefresh(ctx.db);
    const [blocked] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(emailRefreshTarget);
    expect(blocked?.state).toBe("blocked");
    await setMailImport(ctx.db, {
      mailboxId: "synthetic-reopen-mailbox",
      enabled: true,
    });
    const { runs: discovered } = await discoverAiRefresh(ctx.db);
    const rows = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(emailRefreshTarget);
    expect(rows).toHaveLength(2);
    const replacement = rows.find((row) => row.id !== blocked!.id)!;
    expect(replacement).toMatchObject({
      workKey: `${blocked!.workKey}:reopen:1`,
      state: "queued",
      error: null,
      receipt: null,
    });
    // The settled row keeps its Run, receipt and error, linked to its replacement.
    expect(rows.find((row) => row.id === blocked!.id)).toMatchObject({
      runId: blocked!.runId,
      state: "blocked",
      error: blocked!.error,
      receipt: {
        reason: "mailbox_authorization_unavailable",
        retryEvaluationId: replacement.id,
      },
    });
    expect(discovered).toContain(replacement.runId);
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, replacement.runId));
    expect(owner?.status).toBe("running");
    // Queued work is not re-enqueued by another pass.
    expect((await discoverAiRefresh(ctx.db)).runs).not.toContain(
      replacement.runId,
    );
    expect(
      await getDb(ctx.db).select().from(aiEvaluation).where(emailRefreshTarget),
    ).toHaveLength(2);
  });

  it("keeps a running refresh Run open when work joins while its completion waits on the Run lock", async () => {
    const runId = await ensureRun(ctx.db, systemActor(), {
      purpose: "ai_refresh",
      trigger: "scheduled",
      status: "running",
      clientKey: "synthetic-completion-race",
      progress: {
        attempt: 1,
        selected: 0,
        blocked: 0,
        completed: 0,
        failed: 0,
      },
    });
    let completion: Promise<boolean> | undefined;
    await withTransactionDatabase(ctx.db, async (discovery) => {
      // Discovery's lock and insert, held open while the Workflow tries to settle.
      await getDb(discovery)
        .select({ id: run.id })
        .from(run)
        .where(eq(run.id, runId))
        .for("no key update");
      await getDb(discovery)
        .insert(aiEvaluation)
        .values({
          runId,
          feature: "mailbox-triage",
          workKey: "synthetic-completion-race",
          target: aiEvaluationTarget.parse({
            kind: "email",
            entity: "email",
            recordId: crypto.randomUUID(),
            field: null,
            assessmentIds: [],
          }),
          provenance: aiProvenance.parse({
            dependencies: [],
            inputFingerprint: "synthetic",
            optionFingerprint: "",
            model: null,
          }),
          snapshot: {},
        });
      completion = writeRunningAttemptProgress(
        ctx.db,
        runId,
        1,
        { status: "completed", endedAt: new Date() },
        { requireNoOwnedPendingWork: true },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(await completion).toBe(false);
    const [owner] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.id, runId));
    expect(owner?.status).toBe("running");
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
      .where(fieldRefreshTarget);
    await executeAiRefreshTarget(ctx.db, first!.id, ports);
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(aiEvaluation)
          .where(fieldRefreshTarget)
      )[0]?.state,
    ).toBe("completed");
    expect(
      (await getDb(ctx.db).select().from(suggestion))[0]?.supersessionReceipt
        ?.reason,
    ).toBe("no_proposal");
    await discoverAiRefresh(ctx.db, ports);
    expect(
      await getDb(ctx.db).select().from(aiEvaluation).where(fieldRefreshTarget),
    ).toHaveLength(1);
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic changed evidence" });
    await discoverAiRefresh(ctx.db, ports);
    expect(
      await getDb(ctx.db).select().from(aiEvaluation).where(fieldRefreshTarget),
    ).toHaveLength(2);
  });

  it("bounds transient reinference and preserves the same rejected semantic proposal", async () => {
    const item = await productFixture(ctx, "Synthetic retry product");
    await activateAiRefresh(ctx.db, "synthetic-retry", { enabled: true });
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
      suggestPorts: {
        ...categoryPorts(0.6).suggestPorts,
        decisionModel: PRIMARY_MODEL,
      },
    };
    await discoverAiRefresh(ctx.db, ports);
    const [first] = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(fieldRefreshTarget);
    expect(first?.provenance.dependencies).toEqual(
      original?.provenance?.dependencies,
    );
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
          .where(fieldRefreshTarget)
      )[0]?.state,
    ).toBe("failed");
    await executeAiRefreshTarget(ctx.db, first!.id, failing);
    expect(physicalCalls).toBe(3);
    const beforeRediscovery = await getDb(ctx.db)
      .select({ id: run.id })
      .from(run)
      .where(eq(run.purpose, "ai_refresh"));
    for (let pass = 0; pass < 3; pass++) await discoverAiRefresh(ctx.db, ports);
    expect(
      await getDb(ctx.db)
        .select({ id: run.id })
        .from(run)
        .where(eq(run.purpose, "ai_refresh")),
    ).toEqual(beforeRediscovery);
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
      await getDb(ctx.db).select().from(aiEvaluation).where(fieldRefreshTarget)
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
      .where(fieldRefreshTarget);
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
      await getDb(ctx.db).select().from(aiEvaluation).where(fieldRefreshTarget)
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
    expect(await discoverFieldRefresh(ports)).toEqual([]);
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
      await discoverFieldRefresh({
        context: kernelCtx(ctx),
        suggestPorts: categoryPorts(0.6).suggestPorts,
      }),
    ).toEqual([]);
    expect(await readAiDiscoveryCursor(ctx.db)).toMatchObject({
      fieldDone: true,
      emailDone: true,
    });
    expect(
      await getDb(ctx.db).select().from(aiEvaluation).where(fieldRefreshTarget),
    ).toHaveLength(0);
  });
});
