/**
 * The `fields` scope's dangerous rules on a real authored entity (ADR 0028,
 * ADR 0029 sections 1 and 2): Cubby fills an open field from its Answer,
 * never asks about or overwrites a person's value, and never reapplies a
 * value a person ruled out.
 */
import type { ProjectId } from "@cubby/schemas/identifiers";
import { FIELDS_SCOPE } from "@cubby/schemas/kernel/capability";
import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { seedFieldSuggestion } from "tooling/shared-suggestion-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/policy/features";
import { getDb } from "~/server/db/helpers";
import { project } from "~/server/db/schema";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { reviewSuggestion } from "~/server/generic/suggestions/repo/review";
import {
  createKernel,
  defineAsk,
  defineModule,
  startPass,
} from "~/server/kernel/api";
import { readPasses } from "~/server/kernel/pass.fixtures";
import { fieldsReconcilePass } from "~/server/workflows/fields-reconcile-pass";

import { fieldAskInput } from "./ask";
import { insertFieldsFixture } from "./fields.fixtures";
import { fieldsKernelModule } from "./module";
import { fieldsCapabilities, fieldsReconciler } from "./reconciler";
import { applyFieldAuthorityAction } from "./repo/field-actions";
import { fieldAnswer, type FieldAnswer } from "./repo/field-answer";

const RUN = { budgetMs: 20_000 };

describe("fields scope", () => {
  const ctx = withTestDb();

  /** A test kernel whose field Ask answers from `answers` by field. */
  const kernelAnswering = (answers: Record<string, FieldAnswer>) => {
    const ask = defineAsk({
      feature: FIELD_SUGGESTION_FEATURE.feature,
      producer: "model",
      promptVersion: FIELD_SUGGESTION_FEATURE.promptVersion,
      input: fieldAskInput,
      output: fieldAnswer,
      policy: { tier: FIELD_SUGGESTION_FEATURE.tier },
      async produce(input) {
        return {
          output: answers[input.field] ?? { proposal: null, outcome: "none" },
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
  });
  it("prepares a member-held Product tag prune without making a producer call", async () => {
    const record = await insertFieldsFixture(ctx.db, "product", {
      name: "Synthetic cordless tool",
      tags: ["M18"],
    });
    const kernel = createKernel([fieldsKernelModule]);
    await kernel.reconcileNow(ctx.db, [
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
