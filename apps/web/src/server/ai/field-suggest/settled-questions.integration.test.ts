import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { NONE_KEY } from "~/server/ai/policy/decision-choice";
import { inferFieldAssessments } from "~/server/domains/run/operations/ai.server";
import {
  categoryPorts,
  kernelCtx,
  productFixture,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import { readSettledQuestions } from "./settled-questions";

const declines: DecisionPort = async (input) => {
  const keys = Object.keys(input.questions.selection.criteria);
  return {
    answers: {
      selection: {
        type: "choice",
        choice: NONE_KEY,
        confidence: 0.9,
        probabilities: Object.fromEntries(
          keys.map((key) => [
            key,
            key === NONE_KEY ? 0.9 : 0.1 / Math.max(1, keys.length - 1),
          ]),
        ),
      },
    },
  };
};

// Failure modes: a declined list question is re-asked on every visit; a
// remembered decline survives a basis edit, a write to a record the decision
// read beyond its basis, or a new candidate in its vocabulary; a member's
// recorded miss or a pinned grading replay leaves a stale decline in place.
describe("settled suggestion questions", () => {
  const ctx = withTestDb();
  type Question = Pick<FieldSuggestionsInput, "entity" | "basis"> & {
    field: string;
  };
  const fakeRoster = {
    ...categoryPorts().suggestPorts,
    decisionPort: declines,
  };
  const ask = (
    question: Question,
    ports: Parameters<typeof inferFieldAssessments>[2] = {
      decisionPort: declines,
    },
    extra: Pick<FieldSuggestionsInput, "decisionModel"> = {},
  ) =>
    inferFieldAssessments(
      kernelCtx(ctx),
      {
        entity: question.entity,
        basisMode: "suggested",
        targets: [question.field],
        basis: question.basis,
        runKey: crypto.randomUUID(),
        ...extra,
      },
      ports,
    );
  const read = async (
    { entity, ...question }: Question,
    ports: Parameters<typeof readSettledQuestions>[2] = {
      decisionPort: declines,
    },
  ) => {
    const { results } = await readSettledQuestions(
      ctx.db,
      { entity, questions: [{ ...question, basisMode: "suggested" }] },
      ports,
    );
    const [result] = results;
    if (!result?.ok) throw new Error(result?.message ?? "No settled result");
    return result.value.outcome;
  };
  const gadget = (name: string): Question => ({
    entity: "product",
    field: "categoryId",
    basis: { name, manufacturer: null },
  });

  it("remembers a decline until its basis changes or a member records a miss", async () => {
    const answer = await ask(
      gadget("Synthetic unplaceable gadget"),
      fakeRoster,
    );
    const outcome = answer.outcomes?.categoryId;
    expect(outcome).toMatchObject({ kind: "evaluated", answer: "none" });
    expect(
      await read(gadget("Synthetic unplaceable gadget"), fakeRoster),
    ).toEqual(outcome);
    expect(
      await read(gadget("Synthetic unplaceable gadget, renamed"), fakeRoster),
    ).toBeNull();

    // A repeat of the same question adds no second memory row.
    await ask(gadget("Synthetic unplaceable gadget"), fakeRoster);
    expect(
      await read(gadget("Synthetic unplaceable gadget"), fakeRoster),
    ).toEqual(outcome);

    if (outcome?.kind !== "evaluated" || !outcome.assessmentId)
      throw new Error("Synthetic decline has no assessment");
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: outcome.assessmentId,
      operationId: "synthetic:settled-miss",
      verdict: "wrong",
      intent: "history",
    });
    expect(
      await read(gadget("Synthetic unplaceable gadget"), fakeRoster),
    ).toBeNull();
  });

  it("does not remember a pinned-model replay", async () => {
    await ask(gadget("Synthetic replayed gadget"), fakeRoster, {
      decisionModel: "typesafe/jev",
    });
    expect(
      await read(gadget("Synthetic replayed gadget"), fakeRoster),
    ).toBeNull();
  });

  it("reopens when a record the decision read beyond its basis changes", async () => {
    const shelf = await insertWithShortcode(ctx.db, "location", {
      type: "room",
      name: "Synthetic tool shelf",
    });
    const sibling = await productFixture(ctx, "Synthetic stocked wrench", {
      categoryId: taxonomyId("tools"),
    });
    await insertWithShortcode(ctx.db, "inventory", {
      productId: (await resolveProduct(sibling.id)).id,
      locationId: shelf.id,
      amountValue: 1,
      amountUnit: "each",
    });
    const target = await productFixture(ctx, "Synthetic unshelved driver", {
      categoryId: taxonomyId("food"),
    });
    const question: Question = {
      entity: "inventory",
      field: "locationId",
      basis: { productId: target.id },
    };
    const answer = await ask(question);
    expect(answer.outcomes?.locationId).toMatchObject({ answer: "none" });
    expect(await read(question)).toEqual(answer.outcomes?.locationId);

    await executeEntity(kernelCtx(ctx), {
      action: "update",
      entity: "product",
      id: target.id,
      data: { categoryId: taxonomyShortcode("tools") },
    });
    expect(await read(question)).toBeNull();
  });

  it("reopens when its candidate vocabulary gains a record", async () => {
    await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic garden refresh",
    });
    const question: Question = {
      entity: "task",
      field: "projectId",
      basis: { name: "Synthetic patch the attic insulation" },
    };
    const answer = await ask(question);
    expect(answer.outcomes?.projectId).toMatchObject({ answer: "none" });
    expect(await read(question)).toEqual(answer.outcomes?.projectId);

    await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic attic insulation",
    });
    expect(await read(question)).toBeNull();
  });

  // Regression: a re-ask that declined again could not replace the obsolete
  // signature, so the question reopened on every later read.
  it("replaces the remembered inputs when a reopened question declines again", async () => {
    await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic porch repaint",
    });
    const question: Question = {
      entity: "task",
      field: "projectId",
      basis: { name: "Synthetic oil the hinges" },
    };
    await ask(question);
    await insertWithShortcode(ctx.db, "project", {
      name: "Synthetic gutter cleanout",
    });
    expect(await read(question)).toBeNull();

    const again = await ask(question);
    expect(again.outcomes?.projectId).toMatchObject({ answer: "none" });
    expect(await read(question)).toEqual(again.outcomes?.projectId);
  });

  const resolveProduct = async (shortcode: string) => {
    const { resolveOrThrow } =
      await import("~/server/generic/shortcode/repo/shortcode-resolver");
    return { id: await resolveOrThrow(ctx.db, "product", shortcode) };
  };
});
