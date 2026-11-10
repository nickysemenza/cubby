import { AUTOMATIC_RULE_FAMILIES } from "@cubby/schemas/automatic-rule";
import { statementTransactionApplication } from "@cubby/schemas/statement-suggestion";
import { suggestionReviewOut } from "@cubby/schemas/suggestion";
import type { SuggestionFamily } from "@cubby/schemas/suggestion";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import { suggestionTable } from "~/server/db/schema";
import {
  assertApplicationReceipt,
  type recordFeedbackWithInsertion,
} from "~/server/generic/suggestions/repo/suggestion";
import type { decisionForOperation } from "~/server/generic/suggestions/repo/suggestion-decisions";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import type { ReviewFamily } from "~/server/generic/suggestions/repo/suggestion-record-discovery";
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

const APPLICATION_FAMILIES = {
  saved_field: {
    family: "field",
    message: "Saved-field receipts require a field Suggestion",
  },
  product_merge: {
    family: "product_pair",
    message: "Product merge application requires a Product pair Suggestion",
  },
  statement_transaction: {
    family: "statement_transaction",
    message:
      "Statement application requires a Transaction suggestion Suggestion",
  },
  transfer_pair: {
    family: "transfer_pair",
    message: "Transfer-pair application requires a transfer-pair Suggestion.",
  },
} satisfies Record<
  NonNullable<Review["application"]>["kind"],
  { family: SuggestionFamily; message: string }
>;

export function assertApplicationFamily(
  family: SuggestionFamily,
  application: Review["application"],
) {
  if (!application) return;
  const expected = APPLICATION_FAMILIES[application.kind];
  if (expected.family !== family) throw new Error(expected.message);
}

export function planReviewInput(input: Review, prediction: Prediction): Review {
  if (
    input.suppression &&
    (prediction.subject.kind === "statement_transaction" ||
      prediction.subject.kind === "transfer_pair")
  )
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
    if (prediction.subject.kind === "recommendation") {
      if (
        input.suppression.scope !== prediction.subject.scope ||
        input.suppression.candidateKey !== prediction.subject.candidateKey
      )
        throw new Error(
          "Suppression differs from the declared recommendation scope",
        );
    } else if (prediction.subject.kind === "statement_transaction") {
      if (
        input.suppression.scope !== "statement_transaction" ||
        input.suppression.candidateKey !==
          `${prediction.subject.source}:${prediction.subject.chargeKey}`
      )
        throw new Error("Suppression differs from the statement charge");
    } else if (prediction.subject.kind === "transfer_pair") {
      if (
        input.suppression.scope !== "transfer_pair" ||
        input.suppression.candidateKey !== prediction.subject.pairKey
      )
        throw new Error("Suppression differs from the transfer pair");
    } else if (prediction.subject.kind === "product_pair") {
      if (
        input.suppression.scope !== "product_pair" ||
        input.suppression.candidateKey !==
          `${prediction.subject.recordId}|${prediction.subject.otherId}`
      )
        throw new Error("Suppression differs from the canonical Product pair");
    } else
      throw new Error(
        "This Suggestion does not declare a presentation suppression scope",
      );
  }
  if (
    input.intent === "apply" &&
    input.verdict !== "correct" &&
    !input.correction.present
  )
    throw new Error(
      "Applying Feedback requires acceptance or an explicit correction",
    );
  if (input.intent === "draft" && prediction.family !== "field")
    throw new Error("Only field Suggestions support draft acceptance");
  assertApplicationFamily(prediction.family, input.application);
  if (input.correction.present) {
    // A different choice is a Wrong verdict whose correction is that choice.
    if (
      prediction.family === "statement_transaction" &&
      !isEqual(
        statementTransactionApplication.parse(input.correction.value),
        input.application,
      )
    )
      throw new Error(
        "A corrected Transaction suggestion must apply the corrected action",
      );
  }
  return input;
}

export function planApplicationReceipt(
  receipt: ReturnType<typeof decisionForOperation>,
  event: Awaited<ReturnType<typeof recordFeedbackWithInsertion>>["event"],
  outcome: z.infer<typeof suggestionReviewOut>,
) {
  if (receipt) {
    assertApplicationReceipt(receipt, event, "assessment_application");
    const priorOutcome = suggestionReviewOut.parse(receipt.receipt);
    if (
      !isEqual(
        { ...priorOutcome, applicationResult: undefined },
        { ...outcome, applicationResult: undefined },
      )
    )
      throw new Error(
        "Application receipt does not match this command outcome",
      );
    return priorOutcome;
  }
  return null;
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
    (family === "field" && state.status !== "pending")
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
    (state.active || family === "field") &&
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
        family === "field" && input.verdict === "wrong"
          ? z.object({ reviewKey: z.string().nullable() }).safeParse(state.data)
              .data?.reviewKey
          : null,
    };
  }
  return { kind: "unchanged" as const, status: state?.status ?? "historical" };
}
