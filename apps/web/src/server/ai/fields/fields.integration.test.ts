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
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { FIELD_SUGGESTION_FEATURE } from "~/server/ai/policy/features";
import { getDb } from "~/server/db/helpers";
import { project } from "~/server/db/schema";
import { kernelCtx } from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { createKernel, defineAsk, defineModule } from "~/server/kernel/api";

import { fieldAnswer, fieldAskInput, type FieldAnswer } from "./ask";
import { fieldsCapabilities, fieldsReconciler } from "./reconciler";
import { applyFieldAuthorityAction } from "./repo/field-actions";

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
        reconcilers: [fieldsReconciler(ask)],
        machinery: fieldsCapabilities(new Set()),
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
    await kernel.run(ctx.db, RUN);
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
});
