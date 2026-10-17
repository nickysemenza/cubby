import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { NONE_KEY } from "~/server/ai/policy/decision-choice";
import { inferFieldAssessments } from "~/server/domains/run/operations/ai.server";
import {
  categoryPorts,
  kernelCtx,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";

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
// remembered decline survives a basis edit; a member's recorded miss or a
// pinned grading replay leaves a stale decline in place.
describe("settled suggestion questions", () => {
  const ctx = withTestDb();
  const ports = {
    ...categoryPorts().suggestPorts,
    decisionPort: declines,
  };
  const question = (name: string) => ({
    field: "categoryId",
    basisMode: "suggested" as const,
    basis: { name, manufacturer: null },
  });
  const ask = (name: string, extra: { decisionModel?: "typesafe/jev" } = {}) =>
    inferFieldAssessments(
      kernelCtx(ctx),
      {
        entity: "product",
        basisMode: "suggested",
        targets: ["categoryId"],
        basis: { name, manufacturer: null },
        runKey: crypto.randomUUID(),
        ...extra,
      },
      ports,
    );

  it("remembers a decline until its basis changes or a member records a miss", async () => {
    const answer = await ask("Synthetic unplaceable gadget");
    const outcome = answer.outcomes?.categoryId;
    expect(outcome).toMatchObject({ kind: "evaluated", answer: "none" });

    const read = await readSettledQuestions(ctx.db, {
      entity: "product",
      questions: [
        question("Synthetic unplaceable gadget"),
        question("Synthetic unplaceable gadget, renamed"),
      ],
    });
    expect(read.outcomes).toEqual([outcome, null]);

    // A repeat of the same question adds no second memory row.
    await ask("Synthetic unplaceable gadget");
    expect(
      (
        await readSettledQuestions(ctx.db, {
          entity: "product",
          questions: [question("Synthetic unplaceable gadget")],
        })
      ).outcomes,
    ).toEqual([outcome]);

    if (outcome?.kind !== "evaluated" || !outcome.assessmentId)
      throw new Error("Synthetic decline has no assessment");
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: outcome.assessmentId,
      operationId: "synthetic:settled-miss",
      verdict: "wrong",
      intent: "history",
    });
    expect(
      (
        await readSettledQuestions(ctx.db, {
          entity: "product",
          questions: [question("Synthetic unplaceable gadget")],
        })
      ).outcomes,
    ).toEqual([null]);
  });

  it("does not remember a pinned-model replay", async () => {
    await ask("Synthetic replayed gadget", { decisionModel: "typesafe/jev" });
    expect(
      (
        await readSettledQuestions(ctx.db, {
          entity: "product",
          questions: [question("Synthetic replayed gadget")],
        })
      ).outcomes,
    ).toEqual([null]);
  });
});
