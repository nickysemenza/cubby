import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import { eq } from "drizzle-orm";
import {
  taxonomyId,
  taxonomyShortcode,
} from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { markPreparationIncomplete } from "~/server/ai/evaluation-inputs";
import { NONE_KEY } from "~/server/ai/policy/decision-choice";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { aiAnalysis } from "~/server/db/schema";
import { inferFieldAssessments } from "~/server/domains/run/operations/ai.server";
import {
  categoryPorts,
  kernelCtx,
  productFixture,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  fieldQuestionKey,
  readSettledQuestions,
  rememberSettledQuestions,
} from "./settled-questions";

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
  const readAnswer = async (
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
    return result.value;
  };
  const read = async (
    question: Question,
    ports?: Parameters<typeof readSettledQuestions>[2],
  ) => (await readAnswer(question, ports)).outcome;
  const gadget = (name: string): Question => ({
    entity: "product",
    field: "categoryId",
    basis: { name, manufacturer: null },
  });

  // Failure: a first read reports unknown despite an unusable source basis.
  it("returns a source status before any remembered answer exists", async () => {
    expect((await readAnswer(gadget(""))).outcome).toEqual({
      kind: "skipped",
      reason: "no_signal",
    });
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
    // The reopened live ask is keyed by the review, never by the original.
    const reopened = await readAnswer(
      gadget("Synthetic unplaceable gadget"),
      fakeRoster,
    );
    expect(reopened.outcome).toBeNull();
    expect(reopened.revision).toMatch(/^miss:/u);
  });

  // Regression: every unverifiable recheck shared one revision, so a live
  // answer cached by an earlier cold recheck answered a later, changed one.
  it("gives each unverifiable recheck its own revision", async () => {
    const spec = fakeRoster.registry["product.categoryId"];
    const coldRoster = {
      ...fakeRoster,
      registry: {
        "product.categoryId": {
          ...spec,
          roster: async (...args: Parameters<typeof spec.roster>) => {
            markPreparationIncomplete();
            return spec.roster(...args);
          },
        },
      },
    };
    const question = gadget("Synthetic cold gadget");
    await ask(question, coldRoster);
    const first = await readAnswer(question, coldRoster);
    const second = await readAnswer(question, coldRoster);
    expect(first.outcome).toBeNull();
    expect(first.revision).toMatch(/^unverified:/u);
    expect(second.revision).toMatch(/^unverified:/u);
    expect(second.revision).not.toBe(first.revision);
  });

  // Regression: an UPDATE-then-INSERT replacement let concurrent first
  // settles both insert; the unordered read then picked either row.
  it("keeps one effective memory row per question", async () => {
    const question = gadget("Synthetic contended gadget");
    const answer = await ask(question, fakeRoster);
    const outcome = answer.outcomes?.categoryId;
    if (!outcome) throw new Error("Synthetic decline missing");
    const key = await fieldQuestionKey(
      { ...question, basisMode: "suggested" },
      await producingAiManifest(ctx.db),
    );
    const rowsFor = (fingerprint: string) =>
      getDb(ctx.db)
        .select({ id: aiAnalysis.id })
        .from(aiAnalysis)
        .where(eq(aiAnalysis.inputFingerprint, fingerprint));

    const contended = `synthetic-contended-${crypto.randomUUID()}`;
    await Promise.all(
      ["first", "second", "third"].map((signature) =>
        rememberSettledQuestions(ctx.db, [
          { key: contended, outcome, signature },
        ]),
      ),
    );
    expect(await rowsFor(contended)).toHaveLength(1);

    // A duplicate left by an older writer never shadows the newest row.
    await getDb(ctx.db)
      .insert(aiAnalysis)
      .values({
        entityKind: "global",
        entityId: null,
        feature: "field-suggestion.settled-question",
        model: "any",
        promptVersion: "2",
        inputFingerprint: key,
        result: { outcome, signature: "synthetic-stale" },
        createdAt: new Date("2026-01-01T00:00:00Z"),
        updatedAt: new Date("2026-01-01T00:00:00Z"),
      });
    expect(await rowsFor(key)).toHaveLength(2);
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(await read(question, fakeRoster)).toEqual(outcome);
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

  // Regression: a missed question's revision named only the review, so a
  // roster change after the miss kept the empty live retry cached.
  it("moves a missed question's revision when its inputs change", async () => {
    await insertWithShortcode(ctx.db, "location", {
      type: "room",
      name: "Synthetic hall closet",
    });
    const target = await productFixture(ctx, "Synthetic missed lantern");
    const question: Question = {
      entity: "inventory",
      field: "locationId",
      basis: { productId: target.id },
    };
    const answer = await ask(question);
    const outcome = answer.outcomes?.locationId;
    if (outcome?.kind !== "evaluated" || !outcome.assessmentId)
      throw new Error("Synthetic decline has no assessment");
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: outcome.assessmentId,
      operationId: "synthetic:location-miss",
      verdict: "wrong",
      intent: "history",
    });
    const missed = await readAnswer(question);
    expect(missed.outcome).toBeNull();
    expect(missed.revision).toMatch(/^miss:/u);
    // The live retry repeats the rejected assessment and is withheld.
    const retry = await ask(question);
    expect(retry.outcomes?.locationId).toMatchObject({
      reviewStatus: "rejected",
    });
    expect((await readAnswer(question)).revision).toBe(missed.revision);

    await insertWithShortcode(ctx.db, "location", {
      type: "room",
      name: "Synthetic lantern hook",
    });
    const changed = await readAnswer(question);
    expect(changed.outcome).toBeNull();
    expect(changed.revision).toMatch(/^miss:/u);
    expect(changed.revision).not.toBe(missed.revision);
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
