import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import { testShortcode } from "@cubby/schemas/testing";
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
import {
  dependencyStamps,
  fieldDependencyKeys,
} from "~/server/ai/policy/refresh-manifest";
import { producingAiManifest } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { aiAnalysis, assessment, run } from "~/server/db/schema";
import {
  inferFieldAssessments,
  inferFieldAssessmentsBatch,
} from "~/server/domains/run/operations/ai.server";
import {
  categoryPorts,
  kernelCtx,
  productFixture,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity, executeEntityAs } from "~/server/entity-kernel";
import { publishFieldAssessment } from "~/server/generic/assessment/repo/assessment";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { fieldCorrectionKey } from "~/server/generic/assessment/repo/correction-sources";
import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  fieldQuestionKey,
  readSettledQuestions,
  rememberSettledQuestions,
  savedAnswerKey,
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
    extra: Pick<
      FieldSuggestionsInput,
      "decisionModel" | "entityId" | "savedRecord"
    > = {},
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
    basis: { name, brandName: null },
  });

  it.each([taxonomyShortcode("food"), null])(
    "reopens a remembered decline for confirmed correction %s without a provider call",
    async (correctedValue) => {
      const question = gadget("Synthetic corrected memory");
      const declined = await ask(question, fakeRoster);
      expect(await read(question, fakeRoster)).toEqual(
        declined.outcomes?.categoryId,
      );
      const product = await productFixture(ctx, "Synthetic corrected memory");
      const answer = await ask(question, categoryPorts(0.5).suggestPorts, {
        entityId: product.id,
        savedRecord: true,
      });
      const outcome = answer.outcomes?.categoryId;
      if (outcome?.kind !== "evaluated" || !outcome.assessmentId)
        throw new Error("Synthetic source has no assessment");
      const [draft] = await getDb(ctx.db)
        .select()
        .from(assessment)
        .where(eq(assessment.id, outcome.assessmentId));
      const correctionKey = draft && fieldCorrectionKey(draft.evidence);
      expect(correctionKey).toBeTruthy();
      const manifest = await producingAiManifest(ctx.db);
      // The live form answer is display-only. Publish the served saved-field
      // question through the same boundary as refresh/sweep before applying it.
      const served = await publishFieldAssessment(
        ctx.db,
        {
          entity: "product",
          recordId: product.entityId,
          field: "categoryId",
          currentValue: null,
          suggestedValue: taxonomyShortcode("tools"),
          kind: "addition",
          confidence: 0.5,
          model: "typesafe/jev",
          provenance: {
            dependencies: dependencyStamps(
              manifest,
              fieldDependencyKeys("product", "categoryId"),
            ),
            inputFingerprint: "synthetic-memory-input",
            optionFingerprint: "synthetic-memory-roster",
            model: "typesafe/jev",
          },
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
        true,
      );
      await reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: served.id,
        operationId: "synthetic:memory-correction",
        verdict: "wrong",
        intent: "apply",
        correction: { present: true, value: correctedValue },
      });
      const noProvider = {
        ...fakeRoster,
        decisionPort: async () => {
          throw new Error("Preparation called a provider");
        },
      };
      const reopened = await readAnswer(question, noProvider);
      expect(reopened.outcome).toBeNull();
      expect(reopened.revision).toMatch(/^correction:/u);
      expect(await readAnswer(question, noProvider)).toEqual(reopened);
      // An unrelated basis has its own authority and memory scope.
      expect(
        (await readAnswer(gadget("Synthetic unrelated memory"), noProvider))
          .revision,
      ).toBeNull();
      // Retired authority no longer invalidates the unchanged remembered decline.
      await executeEntityAs(kernelCtx(ctx), "update", {
        entity: "product",
        id: product.id,
        data: { categoryId: taxonomyShortcode("books") },
      });
      expect(await read(question, noProvider)).toEqual(
        declined.outcomes?.categoryId,
      );
    },
  );

  // A deferred list decision must retain its own captured evidence so a
  // singleton revisit reuses that publication, not another row's judgment.
  it("preserves each batch item's assessment identity across a singleton revisit", async () => {
    const items = ["Synthetic batch Alpha", "Synthetic batch Beta"].map(
      (name) => ({
        entity: "product" as const,
        basisMode: "suggested" as const,
        targets: ["categoryId"],
        basis: { name, brandName: null },
        runKey: crypto.randomUUID(),
      }),
    );
    const batch = await inferFieldAssessmentsBatch(
      kernelCtx(ctx),
      { items },
      fakeRoster,
    );
    const singles = await Promise.all(
      items.map((item) =>
        inferFieldAssessments(kernelCtx(ctx), item, fakeRoster),
      ),
    );
    expect(
      batch.results.map((result) => (result.ok ? result.value : null)),
    ).toEqual(singles);
    expect(singles[0]?.outcomes?.categoryId).not.toEqual(
      singles[1]?.outcomes?.categoryId,
    );
  });

  // Failure: a first read reports unknown despite an unusable source basis.
  it("returns a source status before any remembered answer exists", async () => {
    expect((await readAnswer(gadget(""))).outcome).toEqual({
      kind: "skipped",
      reason: "no_signal",
    });
  });

  // Failure: first-read preparation errors become successful unknown answers.
  it("reports raw first-read preparation failure while preserving sibling answers", async () => {
    const spec = fakeRoster.registry["product.categoryId"];
    const { results } = await readSettledQuestions(
      ctx.db,
      {
        entity: "product",
        questions: [
          { ...gadget("Synthetic failing roster"), basisMode: "suggested" },
          { ...gadget(""), basisMode: "suggested" },
        ],
      },
      {
        ...fakeRoster,
        registry: {
          "product.categoryId": {
            ...spec,
            roster: async () => {
              throw new Error(
                "Synthetic upstream SQLSTATE 23514 preparation failure",
              );
            },
          },
        },
      },
    );
    expect(results[0]).toEqual({
      ok: false,
      message: "Synthetic upstream SQLSTATE 23514 preparation failure",
    });
    expect(results[1]).toMatchObject({
      ok: true,
      value: { outcome: { kind: "skipped", reason: "no_signal" } },
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

  // Failure modes: a saved list revisit re-prepares rosters, re-asks the
  // model, schedules work or opens a Run before showing an answer it already
  // computed; a weak pick or decline is never remembered for the record; a
  // preview leaks across records, bases or a member's wrong/rejected review;
  // a pinned replay or a form draft poisons the saved record's preview.
  describe("saved-record previews", () => {
    let preparations = 0;
    const refusing = {
      decisionPort: async () => {
        preparations += 1;
        throw new Error("Synthetic preview invoked the decision model");
      },
      registry: {
        "product.categoryId": {
          ...fakeRoster.registry["product.categoryId"],
          roster: async () => {
            preparations += 1;
            throw new Error("Synthetic preview prepared a roster");
          },
        },
      },
    };
    const runCount = async () =>
      (await getDb(ctx.db).select({ id: run.id }).from(run)).length;
    const savedAsk = (
      question: Question,
      entityId: string,
      ports: Parameters<typeof inferFieldAssessments>[2],
      extra: Pick<FieldSuggestionsInput, "decisionModel" | "savedRecord"> = {
        savedRecord: true,
      },
    ) => ask(question, ports, { entityId, ...extra });
    const readPreview = async (
      { entity, ...question }: Question,
      entityId: string,
      basisMode: FieldSuggestionsInput["basisMode"] = "suggested",
    ) => {
      preparations = 0;
      const runs = await runCount();
      const { results } = await readSettledQuestions(
        ctx.db,
        {
          entity,
          read: "preview",
          questions: [{ ...question, entityId, basisMode }],
        },
        refusing,
      );
      expect(preparations).toBe(0);
      expect(await runCount()).toBe(runs);
      const [result] = results;
      if (!result?.ok) throw new Error(result?.message ?? "No preview result");
      expect(result.value.outcome).toBeNull();
      return result.value.preview ?? null;
    };

    it("replays a saved record's weak pick and decline without preparing", async () => {
      const weak = await productFixture(ctx, "Synthetic weak gadget");
      const weakQuestion = gadget("Synthetic weak gadget");
      const weakAnswer = await savedAsk(
        weakQuestion,
        weak.id,
        categoryPorts(0.5).suggestPorts,
      );
      expect(weakAnswer.outcomes?.categoryId).toMatchObject({
        kind: "evaluated",
      });
      expect(await readPreview(weakQuestion, weak.id)).toEqual({
        suggestion: weakAnswer.suggestions.categoryId ?? null,
        outcome: weakAnswer.outcomes?.categoryId,
      });

      const declined = await productFixture(ctx, "Synthetic declined gadget");
      const declinedQuestion = gadget("Synthetic declined gadget");
      const declinedAnswer = await savedAsk(
        declinedQuestion,
        declined.id,
        fakeRoster,
      );
      expect(declinedAnswer.outcomes?.categoryId).toMatchObject({
        answer: "none",
      });
      expect(await readPreview(declinedQuestion, declined.id)).toEqual({
        suggestion: null,
        outcome: declinedAnswer.outcomes?.categoryId,
      });
    });

    it("keys a preview by saved record, basis and basis mode", async () => {
      const product = await productFixture(ctx, "Synthetic keyed gadget");
      const other = await productFixture(ctx, "Synthetic other gadget");
      const question = gadget("Synthetic keyed gadget");
      await savedAsk(question, product.id, categoryPorts(0.5).suggestPorts);
      expect(await readPreview(question, product.id)).not.toBeNull();
      expect(await readPreview(question, other.id)).toBeNull();
      expect(
        await readPreview(
          gadget("Synthetic keyed gadget, renamed"),
          product.id,
        ),
      ).toBeNull();
      expect(await readPreview(question, product.id, "provided")).toBeNull();
    });

    // A decision-policy activation changes every dependency stamp, so the
    // preview computed under the old policy is never looked up again.
    it("keys a preview by its field's decision policy", async () => {
      const manifest = await producingAiManifest(ctx.db);
      const question = {
        ...gadget("Synthetic policy gadget"),
        basisMode: "suggested" as const,
        entityId: testShortcode("product", "policy"),
      };
      const activated = Object.fromEntries(
        Object.entries(manifest).map(([feature, policy]) => [
          feature,
          { ...policy, generation: policy.generation + 1 },
        ]),
      );
      expect(await savedAnswerKey(question, activated)).not.toBe(
        await savedAnswerKey(question, manifest),
      );
      expect(await savedAnswerKey(question, manifest)).not.toBe(
        await fieldQuestionKey(question, manifest),
      );
    });

    it("drops a preview once a member marks its assessment wrong", async () => {
      const product = await productFixture(ctx, "Synthetic reviewed gadget");
      const question = gadget("Synthetic reviewed gadget");
      const answer = await savedAsk(
        question,
        product.id,
        categoryPorts(0.5).suggestPorts,
      );
      const outcome = answer.outcomes?.categoryId;
      if (outcome?.kind !== "evaluated" || !outcome.assessmentId)
        throw new Error("Synthetic weak pick has no assessment");
      expect(await readPreview(question, product.id)).not.toBeNull();
      await reviewAssessment(ctx.db, kernelCtx(ctx), {
        assessmentId: outcome.assessmentId,
        operationId: "synthetic:preview-miss",
        verdict: "wrong",
        intent: "history",
      });
      expect(await readPreview(question, product.id)).toBeNull();
    });

    it("never previews a pinned replay or a form draft", async () => {
      const product = await productFixture(ctx, "Synthetic pinned gadget");
      const question = gadget("Synthetic pinned gadget");
      await savedAsk(question, product.id, fakeRoster, {
        savedRecord: true,
        decisionModel: "typesafe/jev",
      });
      expect(await readPreview(question, product.id)).toBeNull();
      await savedAsk(question, product.id, fakeRoster, {});
      expect(await readPreview(question, product.id)).toBeNull();
    });
  });

  const resolveProduct = async (shortcode: string) => {
    const { resolveOrThrow } =
      await import("~/server/generic/shortcode/repo/shortcode-resolver");
    return { id: await resolveOrThrow(ctx.db, "product", shortcode) };
  };
});
