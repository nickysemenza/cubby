import {
  basisValueOf,
  fieldSuggestionContextKeys,
} from "@cubby/schemas/field-suggestion";
import { runEntityId } from "@cubby/schemas/identifiers";
import { enrollSuggestionCorrectionsInput } from "@cubby/schemas/suggestion-correction";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { driveAiWork } from "tooling/ai-work";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { decisionCatalogRows } from "~/server/ai/decision-catalog";
import { withAiInputs } from "~/server/ai/evaluation-inputs";
import { suggestFields } from "~/server/ai/field-suggest/suggest-fields";
import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import {
  getDb,
  withTransactionDatabase,
  withSnapshotWriteDatabase,
} from "~/server/db/helpers";
import {
  assessment,
  assessmentState,
  assessmentCorrectionLock,
  feedback,
  job,
  auditLog,
  aiEvaluation,
} from "~/server/db/schema";
import { inferFieldAssessments } from "~/server/domains/run/operations/ai.server";
import { systemActor, ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  scheduleSavedFieldQuestion,
  executeAiRefreshTarget,
} from "~/server/domains/run/service/ai-refresh";
import {
  startSuggestionSweep as queueSuggestionSweep,
  publishSweepSuggestions,
  makeSweepSuggestion,
} from "~/server/domains/run/service/suggestion-sweep";
import {
  kernelCtx,
  productFixture,
  productCategoryId,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity, executeEntityAs } from "~/server/entity-kernel";
import {
  publishAssessment,
  publishFieldAssessment,
} from "~/server/generic/assessment/repo/assessment";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { listAutomaticDecisions } from "~/server/generic/assessment/repo/automatic-decisions";
import { applyAutomaticRules } from "~/server/generic/assessment/repo/automatic-rule-runtime";
import { enrollSuggestionCorrections } from "~/server/generic/assessment/repo/correction-enrollment";
import { lockCorrectionKey } from "~/server/generic/assessment/repo/correction-lock";
import {
  readConfirmedCorrection,
  readFieldCorrectionSources,
  readCorrectionTarget,
  correctionTargetIds,
} from "~/server/generic/assessment/repo/correction-sources";
import { recordCorrectionWork } from "~/server/generic/assessment/repo/correction-work";
import { fieldCorrectionIdentity } from "~/server/generic/assessment/repo/field-assessment-review";
import { lockFieldCorrectionScope } from "~/server/generic/assessment/repo/field-correction-lock";
import { publishFieldCorrectionQuestion } from "~/server/generic/assessment/repo/field-correction-publication";
import { fieldCorrectionRepair } from "~/server/generic/assessment/repo/field-correction-repair";
import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";
import { listSuggestionPage } from "~/server/generic/assessment/repo/suggestion-list";
import { correctionPropagationHandler } from "~/server/generic/assessment/service/correction-propagation";
import { latestFieldWrite } from "~/server/generic/audit-log/repo/field-write";
import { advanceJob } from "~/server/generic/jobs/service/jobs";
import { withJobFixtureExecution } from "~/server/testing/background-queue";

describe("confirmed correction propagation", () => {
  const ctx = withTestDb();
  const key = "synthetic-complete-decision-inputs";

  async function propose(
    options: { automatic?: boolean; correctionKey?: string | null } = {},
  ) {
    const product = await productFixture(ctx, "Synthetic classification item");
    const manifest = await producingAiManifest(ctx.db);
    const prediction = await publishFieldAssessment(
      ctx.db,
      {
        entity: "product",
        recordId: product.entityId,
        field: "categoryId",
        currentValue: null,
        suggestedValue: taxonomyShortcode("tools"),
        kind: "addition",
        confidence: options.automatic ? 0.99 : 0.88,
        model: "typesafe/jev",
        provenance: {
          dependencies: dependencyStamps(
            manifest,
            fieldDependencyKeys("product", "categoryId"),
          ),
          inputFingerprint: "synthetic-model-input",
          optionFingerprint: "synthetic-options",
          model: "typesafe/jev",
        },
        data: {
          correctionKey:
            options.correctionKey === undefined ? key : options.correctionKey,
          liveInputFingerprint: await fieldInputFingerprint(
            ctx.db,
            "product",
            product.entityId,
            "categoryId",
          ),
        },
      },
      true,
    );
    const applied = options.automatic
      ? await applyAutomaticRules(ctx.db, [prediction.id])
      : null;
    expect(applied?.applied ?? []).toEqual(
      options.automatic ? [prediction.id] : [],
    );
    return { product, prediction };
  }

  async function correct(value: string | null = taxonomyShortcode("food")) {
    const source = await propose();
    const result = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: source.prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      correction: { present: true, value },
      intent: "apply",
    });
    expect(
      await readConfirmedCorrection(ctx.db, result.feedbackId),
    ).not.toBeNull();
    return { ...source, result };
  }

  async function drain() {
    for (let page = 0; page < 10; page++) {
      const pending = await getDb(ctx.db)
        .select()
        .from(job)
        .where(
          and(
            eq(job.kind, "assessment.correction"),
            inArray(job.state, ["queued", "retry_wait"]),
          ),
        );
      if (!pending.length) return;
      for (const work of pending)
        expect(
          await advanceJob(ctx.db, work.id, {
            "assessment.correction": correctionPropagationHandler,
          }),
        ).toBe("succeeded");
    }
    throw new Error(
      "Synthetic correction work failed to finish its bounded pages",
    );
  }

  it("explicitly enrolls retained field roots without resetting completed history", async () => {
    const target = await propose({ automatic: true });
    const root = await correct();
    await getDb(ctx.db)
      .update(job)
      .set({
        state: "completed",
        result: { status: "held", reason: "Synthetic old identity scan" },
      })
      .where(eq(job.kind, "assessment.correction"));
    const original = await getDb(ctx.db).select().from(job);
    const preview = enrollSuggestionCorrectionsInput.parse({ family: "field" });
    expect(await enrollSuggestionCorrections(ctx.db, preview)).toMatchObject({
      family: "field",
      dryRun: true,
      receiptBackedRoots: 1,
      enrolledRoots: 0,
    });
    expect(await getDb(ctx.db).select().from(job)).toEqual(original);
    const apply = { ...preview, dryRun: false };
    await enrollSuggestionCorrections(ctx.db, apply);
    await enrollSuggestionCorrections(ctx.db, apply);
    const enrolled = await getDb(ctx.db).select().from(job);
    expect(enrolled).toHaveLength(original.length + 1);
    expect(
      enrolled.find((row) => !original.some((old) => old.id === row.id)),
    ).toMatchObject({
      key: `assessment-correction-history:field-identity-v2:${root.result.feedbackId}`,
      state: "queued",
      input: {
        sourceFeedbackId: root.result.feedbackId,
        targetAssessmentId: null,
      },
    });
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBe(
      taxonomyId("food"),
    );
    for (const old of original.filter(
      (row) => row.kind === "assessment.correction",
    ))
      expect(
        (await getDb(ctx.db).select().from(job).where(eq(job.id, old.id)))[0],
      ).toEqual(old);
    const completed = await getDb(ctx.db).select().from(job);
    await enrollSuggestionCorrections(ctx.db, apply);
    expect(await getDb(ctx.db).select().from(job)).toEqual(completed);
  });

  it("checks one publication commit's served targets in one Job", async () => {
    const source = await correct();
    const first = await propose();
    const second = await propose();
    await getDb(ctx.db)
      .delete(job)
      .where(eq(job.kind, "assessment.correction"));
    await recordCorrectionWork(ctx.db, {
      kind: "publications",
      ids: [first.prediction.id, second.prediction.id],
    });
    const queued = await getDb(ctx.db)
      .select()
      .from(job)
      .where(eq(job.kind, "assessment.correction"));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      key: `assessment-correction-publication:${first.prediction.id}`,
      input: {
        sourceFeedbackId: null,
        targetAssessmentIds: [first.prediction.id, second.prediction.id],
      },
    });
    await drain();
    const enrolled = await getDb(ctx.db)
      .select({ key: job.key })
      .from(job)
      .where(eq(job.kind, "assessment.correction"));
    expect(enrolled.map((row) => row.key)).toEqual(
      expect.arrayContaining([
        `assessment-correction:${source.result.feedbackId}:${first.prediction.id}`,
        `assessment-correction:${source.result.feedbackId}:${second.prediction.id}`,
      ]),
    );
  });

  async function preparedQuestion(
    basis: Record<string, string | null> = {
      name: "Synthetic classification item",
      brandName: null,
      categoryId: null,
    },
  ) {
    const runId = runEntityId.parse("00000000-0000-4000-8000-000000000000");
    const input = {
      entity: "product" as const,
      targets: ["categoryId"],
      basisMode: "provided" as const,
      basis,
    };
    const ports = {
      decisionPort: async () => {
        throw new Error("Confirmed correction called a provider");
      },
      recordUsage: false,
    };
    const prepared = await withAiInputs(
      true,
      () => suggestFields(ctx.db, runId, input, ports),
      { providerFree: true },
    );
    const manifest = await producingAiManifest(ctx.db);
    const dependencies = dependencyStamps(manifest, [
      ...fieldDependencyKeys("product", "categoryId"),
      ...prepared.inputs.map((call) => call.feature),
    ]);
    const correctionKey = await fieldCorrectionIdentity({
      entity: "product",
      field: "categoryId",
      basis,
      inputs: prepared.inputs,
      dependencies,
      incomplete: prepared.incomplete,
    });
    if (!correctionKey)
      throw new Error("Synthetic category inputs are incomplete");
    return {
      inputs: prepared.inputs,
      dependencies,
      input,
      runId,
      ports,
      correctionKey,
      provenance: {
        dependencies,
        inputFingerprint: "synthetic-prepared-correction",
        optionFingerprint: correctionKey,
        model: null,
      },
    };
  }

  async function confirmKey(correctionKey: string, value: string | null) {
    const source = await propose({ correctionKey });
    const result = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: source.prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "apply",
      correction: { present: true, value },
    });
    return { ...source, result };
  }

  it.each([taxonomyShortcode("food"), null])(
    "resolves correction %s before the provider and applies with separate automatic provenance",
    async (value) => {
      const question = await preparedQuestion();
      await confirmKey(question.correctionKey, value);
      const target = await productFixture(ctx, "Synthetic classification item");
      const output = await suggestFields(
        ctx.db,
        question.runId,
        { ...question.input, entityId: target.id },
        question.ports,
      );
      const outcome = output.outcomes?.categoryId;
      expect(output.suggestions.categoryId).toBeNull();
      expect(outcome).toMatchObject({
        kind: "correction",
        decision: { status: "confirmed", value },
      });
      expect(outcome).not.toHaveProperty("confidence");
      if (outcome?.kind !== "correction")
        throw new Error("No correction outcome");
      const published = await publishFieldCorrectionQuestion(ctx.db, {
        entity: "product",
        recordId: target.entityId,
        field: "categoryId",
        currentValue: null,
        outcome,
        provenance: question.provenance,
        runId: null,
      });
      expect(published.producer).toMatchObject({ kind: "rule", model: null });
      await drain();
      expect(await productCategoryId(ctx.db, target.id)).toBe(
        value === null ? null : taxonomyId("food"),
      );
      const receipts = await getDb(ctx.db)
        .select()
        .from(feedback)
        .where(eq(feedback.assessmentId, published.id));
      expect(receipts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authority: "automatic",
            intent: "history",
            receipt: expect.objectContaining({ status: "applied" }),
          }),
        ]),
      );
      expect(receipts.some((receipt) => receipt.authority === "member")).toBe(
        false,
      );
    },
  );

  async function legacyQuestion(
    question: Awaited<ReturnType<typeof preparedQuestion>>,
    confidence = 0.88,
  ) {
    const { sha256Hex } = await import("@cubby/shared/sha256");
    const { canonicalJson } = await import("~/server/lib/canonical-json");
    const product = await productFixture(ctx, "Synthetic classification item");
    const basis = { ...question.input.basis, __resolutionContext: "{}" };
    const correctionKey = await sha256Hex(
      canonicalJson({
        version: "field-correction-v1",
        entity: "product",
        field: "categoryId",
        basis,
        inputs: question.inputs,
        dependencies: question.dependencies,
      }),
    );
    const prediction = await publishAssessment(
      ctx.db,
      {
        publicationKey: `synthetic-legacy:${crypto.randomUUID()}`,
        family: "field",
        subject: {
          kind: "field",
          entity: "product",
          recordId: product.entityId,
          field: "categoryId",
        },
        judgment: {
          value: taxonomyShortcode("tools"),
          confidence,
          runnerUpValue: null,
          runnerUpConfidence: null,
          kind: "addition",
        },
        fingerprint: "synthetic-legacy-input",
        producer: null,
        served: true,
        evidence: { correctionKey, basis, inputs: question.inputs },
      },
      {
        currentValue: null,
        provenance: { ...question.provenance, model: "typesafe/jev" },
        suggestedValue: taxonomyShortcode("tools"),
        confidence,
        model: "typesafe/jev",
        kind: "addition",
        data: {
          correctionKey,
          liveInputFingerprint: await fieldInputFingerprint(
            ctx.db,
            "product",
            product.entityId,
            "categoryId",
          ),
        },
      },
    );
    return { product, prediction, correctionKey };
  }

  it("preserves a frozen raw-v1 live root in future canonical inference", async () => {
    const question = await preparedQuestion();
    const source = await legacyQuestion(question);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: source.prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "apply",
      correction: { present: true, value: taxonomyShortcode("food") },
    });
    const output = await suggestFields(
      ctx.db,
      question.runId,
      question.input,
      question.ports,
    );
    expect(output.outcomes?.categoryId).toMatchObject({
      kind: "correction",
      decision: { status: "confirmed", value: taxonomyShortcode("food") },
    });
  });

  it("repairs and re-corrects a frozen raw-v1 target from canonical authority", async () => {
    const question = await preparedQuestion();
    const target = await legacyQuestion(question);
    const first = await confirmKey(
      question.correctionKey,
      taxonomyShortcode("food"),
    );
    const sourceProof = await readConfirmedCorrection(
      ctx.db,
      first.result.feedbackId,
    );
    const targetProof = await readCorrectionTarget(
      ctx.db,
      target.prediction.id,
    );
    if (!sourceProof || !targetProof)
      throw new Error("Missing synthetic repair proofs");
    const repair = await fieldCorrectionRepair.prepare(ctx.db, {
      source: sourceProof,
      target: targetProof,
    });
    if (repair.status === "held") throw new Error(repair.reason);
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBe(
      taxonomyId("food"),
    );
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: first.product.id,
      data: { categoryId: taxonomyShortcode("books") },
    });
    await confirmKey(question.correctionKey, taxonomyShortcode("tools"));
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBe(
      taxonomyId("tools"),
    );
  });

  it("preserves opaque same-key authority alongside a proven canonical alias", async () => {
    const question = await preparedQuestion();
    const source = await legacyQuestion(question);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: source.prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "apply",
      correction: { present: true, value: taxonomyShortcode("food") },
    });
    const opaqueTarget = await propose({ correctionKey: source.correctionKey });
    await drain();
    expect(await productCategoryId(ctx.db, opaqueTarget.product.id)).toBe(
      taxonomyId("food"),
    );
    const opaqueSource = await propose({ correctionKey: source.correctionKey });
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: opaqueSource.prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "apply",
      correction: { present: true, value: null },
    });
    const target = await legacyQuestion(question, 0.99);
    expect(
      (await applyAutomaticRules(ctx.db, [target.prediction.id])).applied,
    ).toEqual([]);
    expect(await productCategoryId(ctx.db, target.product.id)).toBeNull();
    const output = await suggestFields(
      ctx.db,
      question.runId,
      question.input,
      question.ports,
    );
    expect(output.outcomes?.categoryId).toMatchObject({
      kind: "correction",
      decision: { status: "conflict" },
    });
  });

  async function retiredLegacyBridge(
    question: Awaited<ReturnType<typeof preparedQuestion>>,
  ) {
    const proving = await legacyQuestion(question);
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: proving.prediction.id,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "apply",
      correction: { present: true, value: taxonomyShortcode("food") },
    });
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: proving.product.id,
      data: { categoryId: taxonomyShortcode("books") },
    });
    return proving;
  }

  it("applies and re-corrects opaque authority through retired proof to canonical targets", async () => {
    const question = await preparedQuestion();
    const bridge = await retiredLegacyBridge(question);
    const target = await propose({ correctionKey: question.correctionKey });
    const root = await confirmKey(
      bridge.correctionKey,
      taxonomyShortcode("food"),
    );
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBe(
      taxonomyId("food"),
    );
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: root.product.id,
      data: { categoryId: taxonomyShortcode("books") },
    });
    await confirmKey(bridge.correctionKey, taxonomyShortcode("tools"));
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBe(
      taxonomyId("tools"),
    );
    const future = await productFixture(ctx, "Synthetic classification item");
    const output = await suggestFields(
      ctx.db,
      question.runId,
      { ...question.input, entityId: future.id },
      question.ports,
    );
    const outcome = output.outcomes?.categoryId;
    if (outcome?.kind !== "correction")
      throw new Error("No correction outcome");
    expect(outcome.decision).toMatchObject({
      status: "confirmed",
      value: taxonomyShortcode("tools"),
    });
    await publishFieldCorrectionQuestion(ctx.db, {
      entity: "product",
      recordId: future.entityId,
      field: "categoryId",
      currentValue: null,
      outcome,
      provenance: question.provenance,
      runId: null,
    });
    await drain();
    expect(await productCategoryId(ctx.db, future.id)).toBe(
      taxonomyId("tools"),
    );
  });

  it("advances history cursors through nonmatching field candidates", async () => {
    const candidates = await Promise.all(
      ["a", "b", "c"].map((correctionKey) =>
        propose({ correctionKey: `synthetic-${correctionKey}` }),
      ),
    );
    candidates.sort((a, b) => a.prediction.id.localeCompare(b.prediction.id));
    const last = candidates.at(-1)!;
    const target = await readCorrectionTarget(ctx.db, last.prediction.id);
    const key = z
      .object({ correctionKey: z.string() })
      .parse(target?.evidence).correctionKey;
    let after: string | null = null;
    const found = [];
    let emptyBeforeMatch = false;
    for (let page = 0; page < 4; page++) {
      const result = await correctionTargetIds(ctx.db, {
        sourceAssessmentId: crypto.randomUUID(),
        correctionKey: key,
        entity: "product",
        field: "categoryId",
        after,
        limit: 1,
      });
      if (!found.length && !result.targets.length && !result.done)
        emptyBeforeMatch = true;
      found.push(...result.targets.map((row) => row.id));
      after = result.after;
      if (result.done) break;
    }
    expect(emptyBeforeMatch).toBe(true);
    expect(found).toEqual([last.prediction.id]);
  });

  it("reuses a correction from the actual live request in canonical inference and Sweep", async () => {
    const source = await productFixture(ctx, "Synthetic classification item");
    const record = await executeEntity(kernelCtx(ctx), {
      action: "get",
      entity: "product",
      id: source.id,
      missing: "error",
    });
    if (record.action !== "get" || !record.item)
      throw new Error("Missing synthetic Product");
    const row = z.record(z.string(), z.unknown()).parse(record.item);
    const policy = decisionCatalogRows().find(
      (row) => row.entity === "product" && row.field === "categoryId",
    );
    const basis = Object.fromEntries(
      fieldSuggestionContextKeys("product", [
        ...(policy?.basis.map((row) => row.key) ?? []),
        "categoryId",
      ]).map((key) => [key, basisValueOf(row[key])]),
    );
    const question = await preparedQuestion(basis);
    const response = await inferFieldAssessments(
      kernelCtx(ctx),
      {
        ...question.input,
        entityId: source.id,
        basis: { ...question.input.basis, __resolutionContext: "{}" },
      },
      {
        recordUsage: false,
        decisionPort: async (request) => {
          const keys = Object.keys(request.questions.selection.criteria);
          return {
            answers: {
              selection: {
                type: "choice",
                choice: "none",
                confidence: 0.9,
                probabilities: Object.fromEntries(
                  keys.map((key) => [
                    key,
                    key === "none" ? 0.9 : 0.1 / Math.max(1, keys.length - 1),
                  ]),
                ),
              },
            },
          };
        },
      },
    );
    const outcome = response.outcomes?.categoryId;
    const assessmentId =
      outcome && outcome.kind !== "skipped" ? outcome.assessmentId : null;
    if (!assessmentId) throw new Error("Missing actual live assessment");
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: source.id,
      data: { categoryId: taxonomyShortcode("food") },
    });
    const applied = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId,
      operationId: crypto.randomUUID(),
      verdict: "wrong",
      intent: "apply",
      correction: { present: true, value: taxonomyShortcode("food") },
      application: { kind: "saved_field", recordId: source.id },
    });
    expect(
      await readConfirmedCorrection(ctx.db, applied.feedbackId),
    ).not.toBeNull();
    const canonical = await productFixture(
      ctx,
      "Synthetic classification item",
    );
    const reused = await suggestFields(
      ctx.db,
      question.runId,
      { ...question.input, entityId: canonical.id },
      question.ports,
    );
    expect(reused.outcomes?.categoryId).toMatchObject({
      kind: "correction",
      decision: {
        status: "confirmed",
        value: taxonomyShortcode("food"),
      },
    });
    const swept = await productFixture(ctx, "Synthetic classification item");
    const ports = { context: kernelCtx(ctx), suggestPorts: question.ports };
    const started = await queueSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [swept.id] },
      },
      ports,
    );
    await driveAiWork(ctx.db, started.id, { sweep: ports });
    await drain();
    const sweptValue = await productCategoryId(ctx.db, swept.id);

    expect(sweptValue).toBe(taxonomyId("food"));
  });

  it("settles renewed explicit None authority without another field write", async () => {
    const question = await preparedQuestion();
    await confirmKey(question.correctionKey, null);
    const target = await productFixture(ctx, "Synthetic classification item");
    const published = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) await confirmKey(question.correctionKey, null);
      const output = await suggestFields(
        ctx.db,
        question.runId,
        { ...question.input, entityId: target.id },
        question.ports,
      );
      const outcome = output.outcomes?.categoryId;
      if (outcome?.kind !== "correction")
        throw new Error("Missing synthetic None authority");
      published.push(
        await publishFieldCorrectionQuestion(ctx.db, {
          entity: "product",
          recordId: target.entityId,
          field: "categoryId",
          currentValue: null,
          outcome,
          provenance: question.provenance,
          runId: null,
        }),
      );
      await drain();
    }
    const second = published[1];
    if (!second) throw new Error("Missing repeated synthetic question");
    const receipts = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, second.id));
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authority: "automatic",
          receipt: expect.objectContaining({ status: "unchanged" }),
        }),
      ]),
    );
    const [state] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, second.id));
    expect(state).toMatchObject({ active: false, status: "superseded" });
    expect(await productCategoryId(ctx.db, target.id)).toBeNull();
  });

  it("holds conflicting pre-model authority without calling a provider or writing a field", async () => {
    const question = await preparedQuestion();
    await confirmKey(question.correctionKey, taxonomyShortcode("food"));
    await confirmKey(question.correctionKey, taxonomyShortcode("books"));
    const target = await productFixture(ctx, "Synthetic classification item");
    const output = await suggestFields(
      ctx.db,
      question.runId,
      { ...question.input, entityId: target.id },
      question.ports,
    );
    const outcome = output.outcomes?.categoryId;
    expect(outcome).toMatchObject({
      kind: "correction",
      decision: { status: "conflict" },
    });
    if (outcome?.kind !== "correction") throw new Error("No conflict outcome");
    await publishFieldCorrectionQuestion(ctx.db, {
      entity: "product",
      recordId: target.entityId,
      field: "categoryId",
      currentValue: null,
      outcome,
      provenance: question.provenance,
      runId: null,
    });
    const queue = await listSuggestionPage(ctx.db, {
      family: "field",
      recordIds: [target.id],
    });
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          columns: expect.objectContaining({ confidence: null }),
          actions: [
            { verb: "correct", ownerOnly: false },
            { verb: "dismiss", ownerOnly: false },
          ],
        }),
      ]),
    );
    await drain();
    expect(await productCategoryId(ctx.db, target.id)).toBeNull();
  });

  it("keeps a current conflict visible when an obsolete confirmed publication replays", async () => {
    const question = await preparedQuestion();
    await confirmKey(question.correctionKey, taxonomyShortcode("food"));
    const target = await productFixture(ctx, "Synthetic classification item");
    const first = await suggestFields(
      ctx.db,
      question.runId,
      { ...question.input, entityId: target.id },
      question.ports,
    );
    const original = first.outcomes?.categoryId;
    if (original?.kind !== "correction")
      throw new Error("Missing synthetic authority");
    const publish = (outcome: typeof original) =>
      publishFieldCorrectionQuestion(ctx.db, {
        entity: "product",
        recordId: target.entityId,
        field: "categoryId",
        currentValue: null,
        outcome,
        provenance: question.provenance,
        runId: null,
      });
    const old = await publish(original);
    await confirmKey(question.correctionKey, taxonomyShortcode("books"));
    const next = await suggestFields(
      ctx.db,
      question.runId,
      { ...question.input, entityId: target.id },
      question.ports,
    );
    const conflict = next.outcomes?.categoryId;
    if (
      conflict?.kind !== "correction" ||
      conflict.decision.status !== "conflict"
    )
      throw new Error("Missing synthetic conflict");
    const current = await publish(conflict);
    await expect(publish(original)).rejects.toThrow(
      "Correction authority changed during inference",
    );
    const rows = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(inArray(assessmentState.id, [old.id, current.id]));
    expect(rows.find((row) => row.id === old.id)).toMatchObject({
      active: false,
      status: "superseded",
    });
    expect(rows.find((row) => row.id === current.id)).toMatchObject({
      active: true,
      status: "pending",
    });
  });

  it("refuses a correction question when the target changes after preparation", async () => {
    const question = await preparedQuestion();
    await confirmKey(question.correctionKey, taxonomyShortcode("food"));
    const target = await productFixture(ctx, "Synthetic classification item");
    const output = await suggestFields(
      ctx.db,
      question.runId,
      { ...question.input, entityId: target.id },
      question.ports,
    );
    const outcome = output.outcomes?.categoryId;
    if (outcome?.kind !== "correction")
      throw new Error("No correction outcome");
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: target.id,
      data: { categoryId: taxonomyShortcode("books") },
    });
    await expect(
      publishFieldCorrectionQuestion(ctx.db, {
        entity: "product",
        recordId: target.entityId,
        field: "categoryId",
        currentValue: null,
        outcome,
        provenance: question.provenance,
        runId: null,
      }),
    ).rejects.toThrow("target changed");
    expect(await productCategoryId(ctx.db, target.id)).toBe(
      taxonomyId("books"),
    );
  });

  it("does not turn a client-provided saved-record basis into automatic-write authority", async () => {
    const question = await preparedQuestion();
    await confirmKey(question.correctionKey, taxonomyShortcode("food"));
    const target = await productFixture(
      ctx,
      "Synthetic different canonical evidence",
    );
    const output = await inferFieldAssessments(
      kernelCtx(ctx),
      {
        ...question.input,
        entityId: target.id,
        savedRecord: true,
        runKey: crypto.randomUUID(),
      },
      question.ports,
    );
    expect(output.outcomes?.categoryId).toMatchObject({ kind: "correction" });
    await drain();
    expect(await productCategoryId(ctx.db, target.id)).toBeNull();
    expect(
      await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(eq(assessmentState.recordId, target.entityId)),
    ).toEqual([]);
  });

  it("does not double-capture preparation inputs when authority does not match", async () => {
    const question = await preparedQuestion();
    await confirmKey(question.correctionKey, taxonomyShortcode("food"));
    const input = {
      ...question.input,
      basis: { ...question.input.basis, name: "Synthetic different input" },
    };
    const prepared = await withAiInputs(
      true,
      () => suggestFields(ctx.db, question.runId, input, question.ports),
      { providerFree: true },
    );
    let calls = 0;
    const live = await withAiInputs(false, () =>
      suggestFields(ctx.db, question.runId, input, {
        recordUsage: false,
        decisionPort: async (request) => {
          calls++;
          const keys = Object.keys(request.questions.selection.criteria);
          return {
            answers: {
              selection: {
                type: "choice",
                choice: "none",
                confidence: 0.9,
                probabilities: Object.fromEntries(
                  keys.map((key) => [
                    key,
                    key === "none" ? 0.9 : 0.1 / Math.max(1, keys.length - 1),
                  ]),
                ),
              },
            },
          };
        },
      }),
    );
    expect(calls).toBe(1);
    expect(live.inputs).toEqual(prepared.inputs);
    expect(live.result.outcomes?.categoryId).toMatchObject({
      kind: "evaluated",
    });
  });

  it.each([false, true])(
    "holds a snapshot predating a conflicting correction (retained alias: %s)",
    async (retainedAlias) => {
      await activateAiRefresh(ctx.db, "synthetic-disabled-refresh", {
        enabled: false,
        startDiscovery: false,
      });
      const question = await preparedQuestion();
      const bridge = retainedAlias ? await retiredLegacyBridge(question) : null;
      const rootKey = bridge?.correctionKey ?? question.correctionKey;
      const root = await confirmKey(
        question.correctionKey,
        taxonomyShortcode("food"),
      );
      const proposed = await propose({ correctionKey: question.correctionKey });
      const source = await readConfirmedCorrection(
        ctx.db,
        root.result.feedbackId,
      );
      const target = await readCorrectionTarget(ctx.db, proposed.prediction.id);
      if (!source || !target)
        throw new Error("Missing synthetic correction inputs");
      const input = { source, target };
      const prepared = await fieldCorrectionRepair.prepare(ctx.db, input);
      if (prepared.status !== "ready") throw new Error(prepared.reason);
      expect(
        await getDb(ctx.db)
          .select({ key: assessmentCorrectionLock.key })
          .from(assessmentCorrectionLock)
          .where(eq(assessmentCorrectionLock.key, question.correctionKey)),
      ).toHaveLength(1);
      // Exclude incidental shared Job contention from the authority serialization proof.
      await getDb(ctx.db).update(job).set({ state: "failed" });
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const applying = withSnapshotWriteDatabase(
        ctx.db,
        async (db) => {
          await getDb(db)
            .select({ id: assessmentState.id })
            .from(assessmentState)
            .where(eq(assessmentState.id, source.assessmentId));
          started.resolve();
          await release.promise;
          return fieldCorrectionRepair.apply(
            db,
            input,
            prepared.plan,
            systemActor(),
          );
        },
        { isolationLevel: "serializable" },
      );
      await started.promise;
      try {
        await confirmKey(rootKey, taxonomyShortcode("books"));
      } finally {
        release.resolve();
      }
      expect(await applying).toMatchObject({
        status: "held",
        reason: "Equivalent evidence has conflicting member corrections",
      });
      expect(await productCategoryId(ctx.db, proposed.product.id)).toBeNull();
    },
  );

  it("locks legacy and canonical predecessor identities before correction publication", async () => {
    const question = await preparedQuestion();
    const target = await legacyQuestion(question);
    await confirmKey(question.correctionKey, taxonomyShortcode("food"));
    const output = await suggestFields(
      ctx.db,
      question.runId,
      { ...question.input, entityId: target.product.id },
      question.ports,
    );
    const outcome = output.outcomes?.categoryId;
    if (outcome?.kind !== "correction")
      throw new Error("Missing correction outcome");
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const member = withTransactionDatabase(ctx.db, async (db) => {
      await lockFieldCorrectionScope(db, "product", "categoryId");
      await lockCorrectionKey(db, target.correctionKey);
      await getDb(db)
        .select({ id: assessmentState.id })
        .from(assessmentState)
        .where(eq(assessmentState.id, target.prediction.id))
        .for("update");
      ready.resolve();
      await release.promise;
      return reviewAssessment(db, kernelCtx({ db, actor: ctx.actor }), {
        assessmentId: target.prediction.id,
        operationId: crypto.randomUUID(),
        verdict: "wrong",
        intent: "apply",
        correction: { present: true, value: null },
      });
    });
    await ready.promise;
    const started = Promise.withResolvers<number>();
    const publication = withTransactionDatabase(ctx.db, async (db) => {
      const result = z
        .object({ rows: z.array(z.object({ pid: z.number() })) })
        .parse(await getDb(db).execute(sql`SELECT pg_backend_pid() AS pid`));
      started.resolve(result.rows[0]!.pid);
      return publishFieldCorrectionQuestion(db, {
        entity: "product",
        recordId: target.product.entityId,
        field: "categoryId",
        currentValue: null,
        outcome,
        provenance: question.provenance,
        runId: null,
      });
    });
    const pid = await started.promise;
    try {
      await expect
        .poll(
          async () => {
            const result = z
              .object({
                rows: z.array(z.object({ waiting: z.boolean().nullable() })),
              })
              .parse(
                await getDb(ctx.db).execute(
                  sql`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`,
                ),
              );
            return result.rows[0]?.waiting;
          },
          { timeout: 2000 },
        )
        .toBe(true);
    } finally {
      release.resolve();
    }
    const results = await Promise.allSettled([member, publication]);
    if (results[0]?.status === "rejected") throw results[0].reason;
    expect(results[0]?.status).toBe("fulfilled");
    // Publication must reject the now-stale target, rather than deadlocking its review.
    if (results[1]?.status !== "rejected")
      throw new Error("Stale publication unexpectedly succeeded");
    expect(String(results[1].reason)).toMatch(/changed during inference/);
  });

  it("takes correction keys before locking Sweep predecessor projections", async () => {
    const target = await propose();
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "completed",
    });
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const member = withTransactionDatabase(ctx.db, async (db) => {
      await lockFieldCorrectionScope(db, "product", "categoryId");
      await lockCorrectionKey(db, key);
      ready.resolve();
      await release.promise;
      await getDb(db)
        .select({ id: assessmentState.id })
        .from(assessmentState)
        .where(eq(assessmentState.id, target.prediction.id))
        .for("update", { noWait: true });
      return reviewAssessment(db, kernelCtx({ db, actor: ctx.actor }), {
        assessmentId: target.prediction.id,
        operationId: crypto.randomUUID(),
        verdict: "wrong",
        intent: "apply",
        correction: { present: true, value: null },
      });
    });
    await ready.promise;
    const started = Promise.withResolvers<number>();
    const sweep = withTransactionDatabase(ctx.db, async (db) => {
      const result = z
        .object({ rows: z.array(z.object({ pid: z.number() })) })
        .parse(await getDb(db).execute(sql`SELECT pg_backend_pid() AS pid`));
      const pid = result.rows[0]?.pid;
      if (!pid) throw new Error("Missing synthetic Sweep backend");
      started.resolve(pid);
      const entry = makeSweepSuggestion({
        currentValue: null,
        decision: { value: taxonomyShortcode("tools"), confidence: 0.99 },
        model: "typesafe/jev",
      });
      if (!entry) throw new Error("Missing synthetic replacement");
      return publishSweepSuggestions(
        db,
        runId,
        {
          entity: "product",
          recordId: target.product.entityId,
          field: "categoryId",
          currentValue: null,
        },
        [{ ...entry, correctionKey: key }],
        null,
        kernelCtx({ db, actor: ctx.actor }),
      );
    });
    const pid = await started.promise;
    const waiting = await expect
      .poll(
        async () => {
          const result = z
            .object({
              rows: z.array(z.object({ waiting: z.boolean().nullable() })),
            })
            .parse(
              await getDb(ctx.db).execute(
                sql`SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = ${pid}`,
              ),
            );
          return result.rows[0]?.waiting === true;
        },
        { timeout: 2000 },
      )
      .toBe(true)
      .then(
        () => true,
        () => false,
      );
    release.resolve();
    const results = await Promise.allSettled([member, sweep]);
    expect(waiting).toBe(true);
    expect(results[0]?.status).toBe("fulfilled");
    if (results[1]?.status === "rejected") throw results[1].reason;
    expect(results[1]?.status).toBe("fulfilled");
  });

  it("refuses a queued Sweep correction after a basis-only edit", async () => {
    const question = await preparedQuestion();
    await confirmKey(question.correctionKey, taxonomyShortcode("food"));
    const target = await productFixture(ctx, "Synthetic classification item");
    const ports = { context: kernelCtx(ctx), suggestPorts: question.ports };
    const started = await queueSuggestionSweep(
      ctx.db,
      {
        entity: "product",
        fields: ["categoryId"],
        filters: { ids: [target.id] },
      },
      ports,
    );
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: target.id,
      data: { name: "Synthetic changed basis" },
    });
    await driveAiWork(ctx.db, started.id, { sweep: ports });
    const evaluations = await getDb(ctx.db)
      .select()
      .from(aiEvaluation)
      .where(eq(aiEvaluation.runId, started.id));
    expect(evaluations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "failed",
          error: expect.stringContaining(
            "Suggestion basis changed after queuing",
          ),
        }),
      ]),
    );
    expect(await productCategoryId(ctx.db, target.id)).toBeNull();
    const proposals = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.recordId, target.entityId));
    expect(proposals).toHaveLength(0);
  });

  it("refreshes a saved field through correction work without model execution", async () => {
    await activateAiRefresh(ctx.db, "synthetic-correction-before-model", {
      enabled: true,
      startDiscovery: false,
    });
    const target = await productFixture(ctx, "Synthetic classification item");
    const found = await executeEntity(kernelCtx(ctx), {
      action: "get",
      entity: "product",
      id: target.id,
      missing: "error",
    });
    if (found.action !== "get" || !found.item)
      throw new Error("Missing synthetic target");
    const row = z.record(z.string(), z.unknown()).parse(found.item);
    const policy = decisionCatalogRows().find(
      (entry) => entry.entity === "product" && entry.field === "categoryId",
    );
    if (!policy) throw new Error("Missing synthetic field policy");
    const basis = Object.fromEntries(
      [
        ...new Set([...policy.basis.map((entry) => entry.key), "categoryId"]),
      ].map((key) => [key, basisValueOf(row[key])]),
    );
    const question = await preparedQuestion(basis);
    await confirmKey(question.correctionKey, taxonomyShortcode("food"));
    await scheduleSavedFieldQuestion(
      ctx.db,
      {
        kind: "field",
        entity: "product",
        recordId: target.entityId,
        field: "categoryId",
        assessmentIds: [],
      },
      { suggestPorts: question.ports },
    );
    const evaluations = await getDb(ctx.db).select().from(aiEvaluation);
    const evaluation = evaluations.find(
      (entry) =>
        z.object({ recordId: z.string().optional() }).parse(entry.target)
          .recordId === target.entityId,
    );
    if (!evaluation) throw new Error("Missing synthetic correction refresh");
    await withJobFixtureExecution(
      ctx.db,
      {
        key: `ai-evaluation:${evaluation.id}`,
        kind: "ai.evaluation",
        input: { evaluationId: evaluation.id },
      },
      () =>
        executeAiRefreshTarget(ctx.db, evaluation.id, {
          suggestPorts: question.ports,
        }),
    );
    await drain();
    expect(await productCategoryId(ctx.db, target.id)).toBe(taxonomyId("food"));
  });

  it.each([taxonomyShortcode("food"), null])(
    "exposes held correction %s without reusable input proof as a passive history attempt",
    async (value) => {
      const source = await propose({ correctionKey: null });
      const result = await reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: source.prediction.id,
        operationId: "synthetic-incomplete-correction",
        verdict: "wrong",
        correction: { present: true, value },
        intent: "apply",
      });
      expect(
        await readConfirmedCorrection(ctx.db, result.feedbackId),
      ).not.toBeNull();
      await drain();
      const outcomes = await getDb(ctx.db)
        .select()
        .from(feedback)
        .where(
          eq(
            feedback.operationId,
            `correction:${result.feedbackId}:${source.prediction.id}`,
          ),
        );
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]?.receipt).toMatchObject({
        status: "held",
        reason: "Complete decision inputs are not equivalent",
      });
      const pending = await listSuggestionPage(ctx.db, {
        recordIds: [source.product.id],
      });
      const automatic = await listAutomaticDecisions(ctx.db, {
        recordIds: [source.product.id],
      });
      expect(pending.meta.totalCount).toBe(0);
      expect(automatic.totalCount).toBe(1);
      expect(automatic.items[0]?.applicationVerified).toBe(false);
      expect(automatic.items[0]?.summary).toBe(
        "Automatic correction held: Complete decision inputs are not equivalent",
      );
      expect(automatic.items[0]?.correctionAttempt).toMatchObject({
        sourceFeedbackId: result.feedbackId,
        outcome: {
          status: "held",
          reason: "Complete decision inputs are not equivalent",
        },
      });
      expect(await productCategoryId(ctx.db, source.product.id)).toBe(
        value === null ? null : taxonomyId("food"),
      );
      const unrelated = await productFixture(ctx, "Synthetic unrelated record");
      expect(
        (await listAutomaticDecisions(ctx.db, { recordIds: [unrelated.id] }))
          .totalCount,
      ).toBe(0);
      const before = await getDb(ctx.db).select().from(feedback);
      const jobsBefore = await getDb(ctx.db).select().from(job);
      await listAutomaticDecisions(ctx.db, { recordIds: [source.product.id] });
      expect(await getDb(ctx.db).select().from(feedback)).toEqual(before);
      expect(await getDb(ctx.db).select().from(job)).toEqual(jobsBefore);
      const attempt = automatic.items[0]?.correctionAttempt;
      if (!attempt)
        throw new Error("Synthetic correction attempt was not returned");
      await getDb(ctx.db)
        .update(feedback)
        .set({ actorUserId: systemActor().userId })
        .where(eq(feedback.id, attempt.sourceApplicationFeedbackId));
      expect(
        (
          await listAutomaticDecisions(ctx.db, {
            recordIds: [source.product.id],
          })
        ).totalCount,
      ).toBe(0);
      await getDb(ctx.db)
        .update(feedback)
        .set({ actorUserId: ctx.actor.userId })
        .where(eq(feedback.id, attempt.sourceApplicationFeedbackId));
      await getDb(ctx.db)
        .update(feedback)
        .set({ actorUserId: ctx.actor.userId })
        .where(
          eq(
            feedback.operationId,
            `correction:${result.feedbackId}:${source.prediction.id}`,
          ),
        );
      expect(
        (
          await listAutomaticDecisions(ctx.db, {
            recordIds: [source.product.id],
          })
        ).totalCount,
      ).toBe(0);
    },
  );

  it("reads retained GUID handles and pages by the recorded attempt date", async () => {
    const source = await propose({ correctionKey: null });
    const result = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: source.prediction.id,
      operationId: "synthetic-retained-correction",
      verdict: "wrong",
      correction: { present: true, value: taxonomyShortcode("food") },
      intent: "apply",
    });
    await drain();
    const confirmed = await readConfirmedCorrection(ctx.db, result.feedbackId);
    if (!confirmed)
      throw new Error("Synthetic member application was not retained");
    const sourceFeedbackId = "11111111-2222-f333-0444-555555555555";
    const sourceApplicationFeedbackId = "11111111-2222-f333-0444-666666666666";
    await getDb(ctx.db)
      .update(feedback)
      .set({ id: sourceFeedbackId })
      .where(eq(feedback.id, result.feedbackId));
    await getDb(ctx.db)
      .update(feedback)
      .set({
        id: sourceApplicationFeedbackId,
        metadata: sql`${feedback.metadata} || ${JSON.stringify({ commandFeedbackId: sourceFeedbackId })}::jsonb`,
      })
      .where(eq(feedback.id, confirmed.applicationFeedbackId));
    await getDb(ctx.db)
      .update(feedback)
      .set({
        operationId: `correction:${sourceFeedbackId}:${source.prediction.id}`,
        metadata: sql`${feedback.metadata} || ${JSON.stringify({ sourceFeedbackId, sourceApplicationFeedbackId })}::jsonb`,
        createdAt: new Date("2026-10-24T01:00:00.000Z"),
      })
      .where(
        eq(
          feedback.operationId,
          `correction:${result.feedbackId}:${source.prediction.id}`,
        ),
      );
    const later = await propose({ automatic: true });
    await getDb(ctx.db)
      .update(assessment)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(assessment.id, source.prediction.id));
    await getDb(ctx.db)
      .update(assessment)
      .set({ createdAt: new Date("2026-02-01T00:00:00.000Z") })
      .where(eq(assessment.id, later.prediction.id));
    const first = await listAutomaticDecisions(ctx.db, {
      recordIds: [source.product.id, later.product.id],
      limit: 1,
    });
    expect(first.totalCount).toBe(2);
    expect(first.items[0]).toMatchObject({
      id: source.prediction.id,
      applicationVerified: false,
      correctionAttempt: {
        sourceFeedbackId,
        sourceApplicationFeedbackId,
        createdAt: "2026-10-24T01:00:00.000Z",
      },
    });
    const second = await listAutomaticDecisions(ctx.db, {
      recordIds: [source.product.id, later.product.id],
      limit: 1,
      offset: 1,
    });
    expect(second.items[0]?.id).toBe(later.prediction.id);
    expect(second.items[0]?.applicationVerified).toBe(true);
  });

  it("repairs an untouched automatic assignment and an equivalent future weak proposal, once", async () => {
    const historical = await propose({ automatic: true });
    const original = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, historical.prediction.id));
    const source = await correct();
    await drain();
    expect(await productCategoryId(ctx.db, historical.product.id)).toBe(
      taxonomyId("food"),
    );
    const future = await propose();
    await drain();
    expect(await productCategoryId(ctx.db, future.product.id)).toBe(
      taxonomyId("food"),
    );
    const history = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, historical.prediction.id));
    expect(history).toEqual(expect.arrayContaining(original));
    expect(
      history.filter(
        (row) =>
          row.operationId ===
          `correction:${source.result.feedbackId}:${historical.prediction.id}`,
      ),
    ).toHaveLength(1);
    await drain();
    expect(
      await getDb(ctx.db)
        .select()
        .from(feedback)
        .where(eq(feedback.assessmentId, historical.prediction.id)),
    ).toEqual(history);
    const [state] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, historical.prediction.id));
    expect(state?.suggestedValue).toBe(taxonomyShortcode("tools"));
    expect(state?.acceptanceReceipt).toMatchObject({ mode: "automatic" });
    const audit = await listAutomaticDecisions(ctx.db, {
      recordIds: [future.product.id],
    });
    expect(audit.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          automaticRule: "member-correction@1",
          summary: `Automatically corrected to ${JSON.stringify(taxonomyShortcode("food"))}`,
        }),
      ]),
    );
  });

  it("preserves intervening member edits and nonequivalent decision inputs", async () => {
    const edited = await propose({ automatic: true });
    const different = await propose({
      correctionKey: "synthetic-other-inputs",
    });
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: edited.product.id,
      data: { categoryId: taxonomyShortcode("books") },
    });
    await correct();
    await drain();
    expect(await productCategoryId(ctx.db, edited.product.id)).toBe(
      taxonomyId("books"),
    );
    expect(await productCategoryId(ctx.db, different.product.id)).toBeNull();
  });

  it("does not grant authority to history grades or refused applications", async () => {
    const source = await propose();
    const grade = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: source.prediction.id,
      operationId: "synthetic-grade",
      verdict: "wrong",
      intent: "history",
      correction: { present: true, value: null },
    });
    expect(await readConfirmedCorrection(ctx.db, grade.feedbackId)).toBeNull();
    const failed = await propose();
    await expect(
      reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: failed.prediction.id,
        operationId: "synthetic-refused",
        verdict: "wrong",
        intent: "apply",
        correction: { present: true, value: "not-a-category" },
      }),
    ).rejects.toThrow(/category|shortcode|identifier|Invalid/i);
    const rows = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.operationId, "synthetic-refused"));
    expect(rows).toHaveLength(1);
    expect(await readConfirmedCorrection(ctx.db, rows[0]!.id)).toBeNull();
  });

  it("holds conflicting confirmed corrections instead of choosing the latest one", async () => {
    await correct(taxonomyShortcode("food"));
    await correct(taxonomyShortcode("books"));
    const target = await propose();
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBeNull();
    const receipts = await getDb(ctx.db)
      .select()
      .from(feedback)
      .where(eq(feedback.assessmentId, target.prediction.id));
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          receipt: {
            status: "held",
            reason: "Equivalent evidence has conflicting member corrections",
          },
        }),
      ]),
    );
    const history = await listAutomaticDecisions(ctx.db, {
      recordIds: [target.product.id],
    });
    expect(history.totalCount).toBe(1);
    expect(history.items[0]?.applicationVerified).toBe(false);
    expect(history.items[0]?.correction).toBeNull();
    expect(history.items[0]?.correctionAttempt?.outcome).toEqual({
      status: "held",
      reason: "Equivalent evidence has conflicting member corrections",
    });
    const queue = await listSuggestionPage(ctx.db, {
      family: "field",
      recordIds: [target.product.id],
    });
    expect(queue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          summary: expect.arrayContaining([
            expect.objectContaining({
              kind: "text",
              text: expect.stringContaining("conflicting member corrections"),
            }),
          ]),
        }),
      ]),
    );
  });

  it("propagates an explicit null without manufacturing a model confidence", async () => {
    const historical = await propose({ automatic: true });
    await correct(null);
    await drain();
    expect(await productCategoryId(ctx.db, historical.product.id)).toBeNull();
    const [state] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, historical.prediction.id));
    expect(state?.confidence).toBe(0.99);
    expect(state?.suggestedValue).toBe(taxonomyShortcode("tools"));
  });

  it("retires a future non-null proposal when the correction is explicit null", async () => {
    await correct(null);
    const future = await propose();
    await drain();
    expect(await productCategoryId(ctx.db, future.product.id)).toBeNull();
    const [state] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, future.prediction.id));
    expect(state).toMatchObject({ status: "superseded", active: false });
  });

  it("enrolls a publication committed after the correction history scan", async () => {
    let release = () => {};
    let published = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepared = new Promise<void>((resolve) => {
      published = resolve;
    });
    const target = await propose({ correctionKey: "other-inputs" });
    const publication = withTransactionDatabase(ctx.db, async (db) => {
      const manifest = await producingAiManifest(db);
      await publishFieldAssessment(
        db,
        {
          entity: "product",
          recordId: target.product.entityId,
          field: "categoryId",
          currentValue: null,
          suggestedValue: taxonomyShortcode("tools"),
          kind: "addition",
          confidence: 0.88,
          model: "typesafe/jev",
          provenance: {
            dependencies: dependencyStamps(
              manifest,
              fieldDependencyKeys("product", "categoryId"),
            ),
            inputFingerprint: "synthetic-model-input",
            optionFingerprint: "synthetic-options",
            model: "typesafe/jev",
          },
          data: {
            correctionKey: key,
            liveInputFingerprint: await fieldInputFingerprint(
              db,
              "product",
              target.product.entityId,
              "categoryId",
            ),
          },
        },
        true,
      );
      published();
      await barrier;
    });
    await prepared;
    try {
      await correct();
      await drain();
    } finally {
      release();
    }
    await publication;
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBe(
      taxonomyId("food"),
    );
  });

  it("withholds a future confident model answer when a current correction exists", async () => {
    await correct();
    const future = await propose();
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ confidence: 0.99 })
      .where(eq(assessmentState.id, future.prediction.id));
    expect(
      (await applyAutomaticRules(ctx.db, [future.prediction.id])).applied,
    ).toEqual([]);
    expect(await productCategoryId(ctx.db, future.product.id)).toBeNull();
    await drain();
    expect(await productCategoryId(ctx.db, future.product.id)).toBe(
      taxonomyId("food"),
    );
  });

  it("uses one canonical correction when a member saves over an automatic assignment", async () => {
    const historical = await propose({ automatic: true });
    const source = await propose({ automatic: true });
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: source.product.id,
      data: { categoryId: taxonomyShortcode("food") },
    });
    const result = await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: source.prediction.id,
      operationId: "synthetic-saved-correction",
      verdict: "wrong",
      intent: "apply",
      correction: { present: true, value: taxonomyShortcode("food") },
      application: { kind: "saved_field", recordId: source.product.id },
    });
    const roots = await readFieldCorrectionSources(ctx.db, key);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.feedbackId).toBe(result.feedbackId);
    expect(roots[0]?.applicationReceipt).toMatchObject({
      reason: "member_correction",
      mode: "member",
    });
    await drain();
    expect(await productCategoryId(ctx.db, historical.product.id)).toBe(
      taxonomyId("food"),
    );
  });

  it.each([true, false])(
    "repairs prior propagated effects (originally automatic: %s) while preserving member edits",
    async (automatic) => {
      const historical = await propose({ automatic });
      const correctedValue = automatic ? taxonomyShortcode("tools") : null;
      const protectedTarget = await propose({ automatic: true });
      const source = await correct();
      await drain();
      expect(await productCategoryId(ctx.db, historical.product.id)).toBe(
        taxonomyId("food"),
      );
      await executeEntityAs(kernelCtx(ctx), "update", {
        entity: "product",
        id: protectedTarget.product.id,
        data: { categoryId: taxonomyShortcode("books") },
      });
      const protectedFingerprint = await fieldInputFingerprint(
        ctx.db,
        "product",
        protectedTarget.product.entityId,
        "categoryId",
      );
      await executeEntityAs(kernelCtx(ctx), "update", {
        entity: "product",
        id: source.product.id,
        data: { categoryId: correctedValue },
      });
      await reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: source.prediction.id,
        operationId: crypto.randomUUID(),
        verdict: "wrong",
        intent: "apply",
        correction: { present: true, value: correctedValue },
        application: { kind: "saved_field", recordId: source.product.id },
      });
      await drain();
      expect(await productCategoryId(ctx.db, historical.product.id)).toBe(
        automatic ? taxonomyId("tools") : null,
      );
      expect(await productCategoryId(ctx.db, protectedTarget.product.id)).toBe(
        taxonomyId("books"),
      );
      expect(
        await fieldInputFingerprint(
          ctx.db,
          "product",
          protectedTarget.product.entityId,
          "categoryId",
        ),
      ).toBe(protectedFingerprint);
    },
  );

  it("ignores a deleted correction source for later equivalent proposals", async () => {
    const source = await correct();
    await executeEntity(kernelCtx(ctx), {
      action: "delete",
      entity: "product",
      ids: [source.product.id],
    });
    const future = await propose();
    await getDb(ctx.db)
      .update(assessmentState)
      .set({ confidence: 0.99 })
      .where(eq(assessmentState.id, future.prediction.id));
    expect(
      (await applyAutomaticRules(ctx.db, [future.prediction.id])).applied,
    ).toEqual([future.prediction.id]);
    await drain();
    expect(await productCategoryId(ctx.db, future.product.id)).toBe(
      taxonomyId("tools"),
    );
  });

  it("holds a restored source value even when later audit writes sort before its receipt", async () => {
    const target = await propose();
    const source = await correct();
    const root = await readConfirmedCorrection(
      ctx.db,
      source.result.feedbackId,
    );
    const originalAuditIds = root?.fieldApplicationReceipt?.auditIds ?? [];
    expect(originalAuditIds.length).toBeGreaterThan(0);
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: source.product.id,
      data: { categoryId: taxonomyShortcode("books") },
    });
    await executeEntityAs(kernelCtx(ctx), "update", {
      entity: "product",
      id: source.product.id,
      data: { categoryId: taxonomyShortcode("food") },
    });
    // Audit timestamps reflect transaction start, so a later write can sort before the correction.
    await getDb(ctx.db)
      .update(auditLog)
      .set({ createdAt: new Date("2020-01-01T00:00:00Z") })
      .where(
        and(
          eq(auditLog.entityId, source.product.entityId),
          eq(auditLog.action, "update"),
          notInArray(auditLog.id, originalAuditIds),
        ),
      );
    const latest = await latestFieldWrite(
      ctx.db,
      "product",
      source.product.entityId,
      "categoryId",
    );
    expect(originalAuditIds).toContain(latest?.id);
    await drain();
    expect(await productCategoryId(ctx.db, target.product.id)).toBeNull();
  });
});
