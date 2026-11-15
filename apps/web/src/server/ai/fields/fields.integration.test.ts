/**
 * The `fields` scope's dangerous rules on a real authored entity (ADR 0028,
 * ADR 0029 sections 1 and 2): Cubby fills an open field from its Answer,
 * never asks about or overwrites a person's value, and never reapplies a
 * value a person ruled out.
 */
import type { ProjectId } from "@cubby/schemas/identifiers";
import { FIELDS_SCOPE } from "@cubby/schemas/kernel/capability";
import { fromPartial } from "@total-typescript/shoehorn";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import { withTestDb } from "tooling/test-setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/policy/features";
import { setCfEnv } from "~/server/cf-env";
import { getDb } from "~/server/db/helpers";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { product, productCategory, project } from "~/server/db/schema";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import {
  embeddingKernelModule,
  queryEmbeddingAsk,
} from "~/server/generic/embedding/module";
import { embedFixtures } from "~/server/generic/embedding/repo/embedding-drain.fixtures";
import { getSemanticEmbeddingConfig } from "~/server/generic/embedding/service/semantic/config";
import {
  createInMemoryVectorizeIndex,
  productionVectorStore,
} from "~/server/generic/embedding/service/semantic/vector-store";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import {
  createKernel,
  defineAsk,
  defineModule,
  startPass,
  withAsk,
} from "~/server/kernel/api";
import { computeBatch } from "~/server/kernel/compute";
import { readPasses } from "~/server/kernel/pass.fixtures";
import { gatewayEgressEnv } from "~/server/testing/ai-gateway-egress";
import {
  createIngredientFixture,
  createProductIdentityFixture,
  makeProductInput,
} from "~/server/testing/repo.fixtures";
import { fieldsReconcilePass } from "~/server/workflows/fields-reconcile-pass";

import { fieldAsk, fieldAskInput, type FieldAskInput } from "./ask";
import { insertFieldsFixture } from "./fields.fixtures";
import { fieldsKernelModule } from "./module";
import { fieldsCapabilities, fieldsReconciler } from "./reconciler";
import { applyFieldAuthorityAction } from "./repo/field-actions";
import { fieldAnswer, type FieldAnswer } from "./repo/field-answer";

const RUN = { budgetMs: 20_000 };

describe("fields scope", () => {
  const ctx = withTestDb();
  afterEach(() => {
    setCfEnv(undefined);
    vi.unstubAllGlobals();
  });

  /** A test kernel whose field Ask answers from `answers` by field. */
  const kernelAnswering = (
    answers: Record<
      string,
      FieldAnswer | ((input: FieldAskInput) => FieldAnswer)
    >,
  ) => {
    const ask = defineAsk({
      feature: FIELD_SUGGESTION_FEATURE.feature,
      producer: "model",
      promptVersion: FIELD_SUGGESTION_FEATURE.promptVersion,
      input: fieldAskInput,
      output: fieldAnswer,
      policy: { tier: FIELD_SUGGESTION_FEATURE.tier },
      async produce(input) {
        const answer = answers[input.field];
        return {
          output: (typeof answer === "function" ? answer(input) : answer) ?? {
            proposal: null,
            outcome: "none",
          },
        };
      },
    });
    const kernel = createKernel([
      defineModule({
        name: "fields",
        asks: [ask],
        passes: [fieldsReconcilePass],
        reconcilers: [fieldsReconciler(ask)],
        machinery: fieldsCapabilities(),
      }),
    ]);
    return { kernel };
  };
  const stored = async (id: ProjectId) =>
    (
      await getDb(ctx.db)
        .select({ kind: project.kind, emoji: project.emoji })
        .from(project)
        .where(eq(project.id, id))
    )[0]!;

  it("fills an open field, keeps a person's value, and never reapplies a ruled-out value", async () => {
    const created = await createRepoEntity(ctx, "project", {
      name: "Synthetic shed roof repair",
      kind: "household",
    });
    const id = created.entityId;
    const { kernel } = kernelAnswering({
      emoji: {
        proposal: {
          value: "🛠️",
          label: null,
          confidence: 0.95,
          runnerUp: null,
        },
        outcome: "pick",
      },
      kind: {
        proposal: {
          value: "renovation",
          label: null,
          confidence: 0.99,
          runnerUp: null,
        },
        outcome: "pick",
      },
    });
    await startPass(ctx.db, fieldsReconcilePass, {
      key: "synthetic.field-request",
      cursor: { key: `project:${id}`, runId: null },
    });
    await kernel.run(ctx.db, RUN);
    expect(
      (await readPasses(ctx.db, { name: "fields.reconcile" }))[0],
    ).toMatchObject({ doneAt: expect.any(Date), lastError: null });
    // The creator set the kind: a person holds it, so Cubby's confident
    // answer never replaces it.
    expect(await stored(id)).toEqual({ kind: "household", emoji: "🛠️" });

    await applyFieldAuthorityAction(ctx.db, ctx.actor, {
      entity: "project",
      id: created.output.id,
      field: "emoji",
      action: "clear",
    });
    expect((await stored(id)).emoji).toBeNull();
    await kernel.reconcileNow(ctx.db, [
      { kind: FIELDS_SCOPE, key: `project:${id}` },
    ]);
    await kernel.run(ctx.db, RUN);
    expect((await stored(id)).emoji).toBeNull();

    // A member's edit is an assignment the scope applies; Cubby never revises it.
    await executeEntity(kernelCtx(ctx), {
      action: "update",
      entity: "project",
      id: created.output.id,
      data: { kind: "garden" },
    });
    await kernel.run(ctx.db, RUN);
    expect((await stored(id)).kind).toBe("garden");

    const q = repositoryQueries(ctx.db);
    const [category] = await q
      .select({ id: productCategory.id })
      .from(productCategory)
      .where(eq(productCategory.feature, "food"));
    expect(category).toBeTruthy();
    const brand = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic pantry brand",
    });
    const ingredient = await createIngredientFixture(
      ctx.db,
      { name: "Synthetic carrot ingredient" },
      ctx.actor,
    );
    const item = await createProductIdentityFixture(
      ctx.db,
      makeProductInput({ name: "Synthetic loose carrots" }),
      ctx.actor,
    );
    const pick = (value: string): FieldAnswer => ({
      proposal: { value, label: null, confidence: 0.99, runnerUp: null },
      outcome: "pick",
    });
    const vectorIndex = createInMemoryVectorizeIndex();
    setCfEnv(
      fromPartial<Env>({
        ...gatewayEgressEnv("synthetic-gateway-token"),
        VECTORIZE: vectorIndex,
      }),
    );
    const transport = vi.fn(() => {
      throw new Error("Synthetic providers must answer this journey");
    });
    vi.stubGlobal("fetch", transport);
    const dependentKernel = createKernel([
      fieldsKernelModule,
      embeddingKernelModule,
    ]);
    const scope = { kind: FIELDS_SCOPE, key: `product:${item.entityId}` };
    const prepare = async () => {
      const [computed] = await computeBatch(
        q,
        dependentKernel.registry,
        dependentKernel.registry.reconcilers.get(FIELDS_SCOPE)!,
        [scope],
        { db: ctx.db, locked: false, hideBaseline: true },
      );
      expect(computed!.error).toBeNull();
      return computed!;
    };
    const answerFields = async (ready: boolean) => {
      const computed = await prepare();
      for (const missing of computed.missing) {
        if (missing.kind.feature !== fieldAsk.feature) continue;
        const input = fieldAskInput.parse(missing.envelope.input);
        const value =
          input.field === "categoryId"
            ? category!.id
            : input.field === "brandId"
              ? brand.entityId
              : ready && input.field === "ingredientId"
                ? ingredient.entityId
                : null;
        await withAsk(
          ctx.db,
          {
            ...fieldAsk,
            admit: async () => {},
            produce: async () => ({
              output: value
                ? pick(value)
                : { proposal: null, outcome: "no_candidates" },
            }),
          },
          input,
          { record: { entity: "product", id: item.entityId } },
        );
      }
    };
    await answerFields(false);
    await dependentKernel.reconcileNow(ctx.db, [scope]);
    const cold = await prepare();
    expect(
      cold.missing.filter(
        (entry) => entry.kind.feature === queryEmbeddingAsk.feature,
      ),
    ).toHaveLength(1);
    expect(
      cold.missing.filter(
        (entry) =>
          entry.kind.feature === fieldAsk.feature &&
          fieldAskInput.parse(entry.envelope.input).field === "ingredientId",
      ),
    ).toHaveLength(0);
    const query = queryEmbeddingAsk.input.parse(
      cold.missing.find(
        (entry) => entry.kind.feature === queryEmbeddingAsk.feature,
      )!.envelope.input,
    );
    const config = getSemanticEmbeddingConfig();
    const vector = Array.from({ length: config.dimensions }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    await withAsk(
      ctx.db,
      {
        ...queryEmbeddingAsk,
        produce: async () => ({ output: vector, model: config.model }),
      },
      query,
    );
    await embedFixtures(
      ctx.db,
      [{ entityKind: "ingredient", entityId: ingredient.entityId }],
      {
        configured: () => true,
        config: getSemanticEmbeddingConfig,
        vectorStore: productionVectorStore,
        embed: async (texts) => texts.map(() => vector),
      },
    );
    const warm = await prepare();
    const ingredientRequest = warm.missing.find(
      (entry) =>
        entry.kind.feature === fieldAsk.feature &&
        fieldAskInput.parse(entry.envelope.input).field === "ingredientId",
    );
    expect(
      fieldAskInput.parse(ingredientRequest!.envelope.input).questions?.length,
    ).toBeGreaterThan(0);
    await answerFields(true);
    await dependentKernel.reconcileNow(ctx.db, [scope]);
    expect(
      await getDb(ctx.db)
        .select({
          categoryId: product.categoryId,
          ingredientId: product.ingredientId,
          brandId: product.brandId,
        })
        .from(product)
        .where(eq(product.id, item.entityId)),
    ).toEqual([
      {
        categoryId: category!.id,
        ingredientId: ingredient.entityId,
        brandId: brand.entityId,
      },
    ]);
    expect(transport).not.toHaveBeenCalled();
  });
  it("prepares a member-held Product tag prune without making a producer call", async () => {
    const record = await insertFieldsFixture(ctx.db, "product", {
      name: "Synthetic cordless tool",
      tags: ["M18"],
    });
    const other = await insertFieldsFixture(ctx.db, "product", {
      name: "Synthetic work light",
      tags: ["M12"],
    });
    const kernel = createKernel([fieldsKernelModule, embeddingKernelModule]);
    await kernel.reconcileNow(ctx.db, [
      { kind: FIELDS_SCOPE, key: `product:${other.id}` },
      { kind: FIELDS_SCOPE, key: `product:${record.id}` },
    ]);
    const { ask } = await import("~/server/db/kernel-schema");
    const rows = await getDb(ctx.db)
      .select()
      .from(ask)
      .where(eq(ask.feature, FIELD_SUGGESTION_FEATURE.feature));
    const inputs = rows.map(
      (row) => z.object({ input: fieldAskInput }).parse(row.input).input,
    );
    expect(
      inputs.find(
        (input) => input.recordId === record.id && input.field === "tags",
      )?.questions,
    ).toEqual(expect.any(Array));
    expect(
      inputs
        .filter((input) => input.field === "tags")
        .map((input) => ({
          id: input.recordId,
          tags: input.row.tags,
          questions: input.questions,
        })),
    ).toEqual(
      expect.arrayContaining([
        { id: record.id, tags: ["M18"], questions: expect.any(Array) },
        { id: other.id, tags: ["M12"], questions: expect.any(Array) },
      ]),
    );
    expect(rows.every((row) => row.sentAt === null)).toBe(true);
  });

  it("dismisses a proposal on a blank field without assigning None or requiring a current value", async () => {
    const record = await createRepoEntity(ctx, "project", {
      name: "Synthetic blank field review",
      kind: "household",
    });
    const proposal = await seedFieldSuggestion(ctx.db, {
      entity: "project",
      recordId: record.entityId,
      field: "emoji",
      suggestedValue: "🪴",
      confidence: 0.7,
    });
    await expect(
      reviewSuggestion(ctx.db, kernelCtx(ctx), {
        suggestionId: proposal.id,
        operationId: "synthetic-blank-dismiss",
        verdict: "dismissed",
        intent: "history",
        expectedFingerprint: proposal.id,
      }),
    ).resolves.toMatchObject({ status: "waiting" });
    expect((await stored(record.entityId)).emoji).toBeNull();
    const { decision } = await import("~/server/db/kernel-schema");
    const decisions = await getDb(ctx.db)
      .select()
      .from(decision)
      .where(eq(decision.subject, `project:${record.entityId}`));
    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "veto",
          field: "emoji",
          value: "🪴",
        }),
      ]),
    );
    expect(
      decisions.filter(
        (row) => row.field === "emoji" && row.channel === "assignment",
      ),
    ).toEqual([]);
  });

  it("keeps vetoes independent of corrections and replays only the exact field command", async () => {
    const record = await createRepoEntity(ctx, "project", {
      name: "Synthetic field review",
      kind: "household",
    });
    const first = await seedFieldSuggestion(ctx.db, {
      entity: "project",
      recordId: record.entityId,
      field: "emoji",
      suggestedValue: "🪴",
      confidence: 0.6,
    });
    const command = {
      suggestionId: first.id,
      operationId: "synthetic-field-command",
      verdict: "wrong" as const,
      intent: "apply" as const,
      expectedFingerprint: first.id,
      correction: { present: true as const, value: "🛠️" },
    };
    const receipt = await reviewSuggestion(ctx.db, kernelCtx(ctx), command);
    expect(receipt).toMatchObject({ status: "waiting" });
    await createKernel([fieldsKernelModule]).reconcileNow(ctx.db, [
      { kind: FIELDS_SCOPE, key: `project:${record.entityId}` },
    ]);
    expect((await stored(record.entityId)).emoji).toBe("🛠️");
    expect(await reviewSuggestion(ctx.db, kernelCtx(ctx), command)).toEqual(
      receipt,
    );
    await expect(
      reviewSuggestion(ctx.db, kernelCtx(ctx), {
        ...command,
        correction: { present: true, value: "🌱" },
      }),
    ).rejects.toThrow("different review");
    const { decision } = await import("~/server/db/kernel-schema");
    const rows = await getDb(ctx.db)
      .select()
      .from(decision)
      .where(eq(decision.subject, `project:${record.entityId}`));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "veto", value: "🪴" }),
        expect.objectContaining({ channel: "assignment", value: "🛠️" }),
      ]),
    );
  });
});
