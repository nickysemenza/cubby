import { AUTOMATIC_RULE_FAMILIES } from "@cubby/schemas/automatic-rule";
import { suggestionReviewOut } from "@cubby/schemas/suggestion";
import type { SuggestionFamily } from "@cubby/schemas/suggestion";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { suggestionTable } from "~/server/db/schema";
import {
  assertApplicationReceipt,
  type FeedbackEvent,
} from "~/server/generic/suggestions/repo/suggestion";
import type { decisionForOperation } from "~/server/generic/suggestions/repo/suggestion-decisions";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import {
  isReviewFamily,
  type ReviewFamily,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import type { SuggestionStateRow } from "~/server/generic/suggestions/repo/suggestion-state";

import type { AutomaticReview, Review } from "./review";

export type Prediction = Pick<
  typeof suggestionTable.$inferSelect,
  | "id"
  | "family"
  | "subject"
  | "judgment"
  | "producer"
  | "evidence"
  | "fingerprint"
>;

export function assertReviewAction(
  name: ReviewFamily,
  verdict: Review["verdict"],
  automatic: AutomaticReview | null,
) {
  if (automatic && !AUTOMATIC_RULE_FAMILIES.some((rule) => rule === name))
    throw new Error(`${name} Suggestions have no Automatic rule; review them`);
  if (
    !(
      suggestionFamilies[name].actions ?? [
        "correct",
        "wrong",
        "uncertain",
        "dismissed",
      ]
    ).some((action) => action === verdict)
  )
    throw new Error(`Unsupported ${name} review action ${verdict}`);
}

export function assertApplicationFamily(
  family: SuggestionFamily,
  application: Review["application"],
) {
  if (!application) return;
  const expected = Object.values(suggestionFamilies).find(
    (declaration) => declaration.applicationKind === application.kind,
  );
  if (!expected) throw new Error(`Unsupported application ${application.kind}`);
  if (
    !isReviewFamily(family) ||
    suggestionFamilies[family].applicationKind !== application.kind
  )
    throw new Error(expected.applicationError);
}

export function planReviewInput(input: Review, prediction: Prediction): Review {
  if (!isReviewFamily(prediction.family))
    throw new Error(
      `${prediction.family} Suggestions are not reviewed as Suggestions`,
    );
  const family = suggestionFamilies[prediction.family];
  if (input.suppression && family.financial)
    input = {
      ...input,
      suppression: {
        ...input.suppression,
        fingerprint: prediction.fingerprint,
      },
    };
  if (input.suppression) {
    if (
      !["dismissed", "wrong"].includes(input.verdict) ||
      input.intent !== "history"
    )
      throw new Error(
        "Suppression requires history-only Dismissal or Wrong Feedback",
      );
    // SAFETY: review validates the subject against the selected family before planning.
    const key = family.suppressionKey?.(prediction.subject as never);
    if (!key)
      throw new Error(
        "This Suggestion does not declare a presentation suppression scope",
      );
    if (
      input.suppression.scope !== key.scope ||
      input.suppression.candidateKey !== key.candidateKey
    )
      throw new Error(key.error);
  }
  if (
    input.intent === "apply" &&
    input.verdict !== "correct" &&
    !input.correction.present
  )
    throw new Error(
      "Applying Feedback requires acceptance or an explicit correction",
    );
  if (input.intent === "draft" && !family.supportsDraft)
    throw new Error("Only field Suggestions support draft acceptance");
  assertApplicationFamily(prediction.family, input.application);
  family.validateCorrection?.(input);
  return input;
}

export function planApplicationReceipt(
  receipt: NonNullable<ReturnType<typeof decisionForOperation>>,
  event: FeedbackEvent,
  outcome: z.infer<typeof suggestionReviewOut>,
) {
  assertApplicationReceipt(receipt, event, "assessment_application");
  const priorOutcome = suggestionReviewOut.parse(receipt.receipt);
  if (
    !isEqual(
      { ...priorOutcome, applicationResult: undefined },
      { ...outcome, applicationResult: undefined },
    )
  )
    throw new Error("Application receipt does not match this command outcome");
  return priorOutcome;
}

export function planApplicableState(
  state: SuggestionStateRow | undefined,
  family: SuggestionFamily,
) {
  if (!state?.active || state.status === "superseded")
    throw new Error(
      "Suggestion evidence is stale; request a fresh suggestion before applying",
    );
  if (
    state.status === "applied" ||
    (isReviewFamily(family) &&
      suggestionFamilies[family].fieldHistory &&
      state.status !== "pending")
  )
    throw new Error(
      "Suggestion already resolved by another command; request a fresh suggestion",
    );
  return state;
}

export function planReviewHistory(
  input: Review,
  family: SuggestionFamily,
  state:
    | Pick<
        typeof suggestionTable.$inferSelect,
        "id" | "active" | "status" | "data"
      >
    | undefined,
) {
  if (state?.active && input.suppression) {
    if (!["dismissed", "wrong"].includes(input.verdict))
      throw new Error(
        "Only history Dismissal or Wrong Feedback accepts suppression scope",
      );
    return {
      kind: "suppression" as const,
      id: state.id,
      suppression: input.suppression,
    };
  }
  if (
    state &&
    (state.active ||
      (isReviewFamily(family) && suggestionFamilies[family].fieldHistory)) &&
    !["applied", "superseded"].includes(state.status) &&
    input.verdict !== "uncertain"
  ) {
    return {
      kind: "transition" as const,
      id: state.id,
      nextStatus:
        input.verdict === "wrong"
          ? ("rejected" as const)
          : ("resolved" as const),
      reviewKey:
        isReviewFamily(family) &&
        suggestionFamilies[family].fieldHistory &&
        input.verdict === "wrong"
          ? z.object({ reviewKey: z.string().nullable() }).safeParse(state.data)
              .data?.reviewKey
          : null,
    };
  }
  return { kind: "unchanged" as const, status: state?.status ?? "historical" };
}
