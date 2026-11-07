import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import {
  AUTOMATIC_RULE_FAMILIES,
  type AutomaticRuleKey,
} from "@cubby/schemas/automatic-rule";
import { statementTransactionApplication } from "@cubby/schemas/statement-suggestion";
import {
  suggestionReviewInput,
  suggestionFamily,
  suggestionReviewBatchInput,
  suggestionSubjects,
  suggestionProjectionTargets,
  suggestionReviewOut,
  mailDecisionFamily,
  type SuggestionFamily,
} from "@cubby/schemas/suggestion";
import { getErrorMessage } from "@cubby/shared";
import { and, eq, or, sql } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  withTransactionDatabase,
  withSnapshotWriteDatabase,
} from "~/server/db/helpers";
import { suggestionTable } from "~/server/db/schema";
import type { EmailEvidenceWriteScope } from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import { withEmailReviewBoundary } from "~/server/domains/purchase-import/repo/email-review-intent";
import {
  resolveMailDecisionHandle,
  settleMailDecisionReview,
} from "~/server/domains/purchase-import/repo/mail-decision-review";
import { statementSuggestionSourceHeld } from "~/server/domains/transaction-import/repo/source-observation-state";
import type { StatementSuggestionScope } from "~/server/domains/transaction-import/repo/statement-input";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { fieldInputFingerprint } from "~/server/generic/suggestions/repo/field-input-fence";
import {
  assertApplicationReceipt,
  recordFeedback,
  recordFeedbackWithInsertion,
} from "~/server/generic/suggestions/repo/suggestion";
import { decisionForOperation } from "~/server/generic/suggestions/repo/suggestion-decisions";
import { suggestionFamilies } from "~/server/generic/suggestions/repo/suggestion-family-declarations";
import { acknowledgeSavedField } from "~/server/generic/suggestions/repo/suggestion-field-receipt";
import {
  isReviewFamily,
  type ReviewFamily,
} from "~/server/generic/suggestions/repo/suggestion-record-discovery";
import {
  type SuggestionStateRow,
  suggestionStateColumns,
  suggestionRecordId,
  transitionSuggestionState,
  transitionSuggestionStates,
} from "~/server/generic/suggestions/repo/suggestion-state";

const stateDataObject = z.record(z.string(), z.json());

type Review = z.infer<typeof suggestionReviewInput>;

/**
 * Internal only, set by `applyAutomaticRules` with the system actor: no
 * public schema carries it. It records `automatic` Feedback naming the rule.
 */
export type AutomaticReview = {
  authority: "automatic";
  rule: { key: AutomaticRuleKey; revision: string; stamp: string };
  statementScope?: StatementSuggestionScope;
};
const automaticReviewInput = suggestionReviewInput.extend({
  operationId: z.string().regex(/^automatic:/),
});
export type Handler = {
  subject?: z.ZodType;
  target?: z.ZodType;
  actions?: readonly Review["verdict"][];
  transactionBound?: boolean;
  /** Snapshot-dependent domain planning owns the outer retry boundary. */
  isolationLevel?: "serializable";
  /** Domain parent locks must precede the suggestion's projection row lock. */
  lockForApply?: (
    db: Database,
    prediction: Pick<
      typeof suggestionTable.$inferSelect,
      "subject" | "judgment"
    >,
  ) => Promise<void>;
  /** The fingerprint a review must match; defaults to the stored one. */
  currentFingerprint?: (
    db: Database,
    state: SuggestionStateRow,
  ) => Promise<string | null>;
  apply: (
    db: Database,
    context: EntityKernelContext & { reviewFeedbackId: string },
    state: SuggestionStateRow,
    input: Review,
    automatic: AutomaticReview | null,
  ) => Promise<z.infer<typeof suggestionReviewOut>["applicationResult"] | void>;
};

/**
 * History settles first. A stale or refused application cannot erase the
 * review. An automatic application is the exception: nobody reviewed it, so
 * a refusal leaves no Feedback at all.
 */
export async function reviewSuggestion(
  db: Database,
  context: EntityKernelContext,
  raw: z.input<typeof suggestionReviewInput>,
  automatic?: AutomaticReview,
  emailScope?: EmailEvidenceWriteScope,
) {
  if (!automatic)
    return settleReview(
      db,
      context,
      suggestionReviewInput.parse(raw),
      null,
      emailScope,
    );
  const input = automaticReviewInput.parse(raw);
  if (
    !input.suggestionId ||
    input.verdict !== "correct" ||
    input.intent !== "apply" ||
    input.correction.present ||
    input.suppression
  )
    throw new Error("An Automatic rule only accepts an Suggestion as is");
  const suggestionId = input.suggestionId;
  const { assertAutomaticRuleOn } =
    await import("~/server/generic/suggestions/repo/automatic-application");
  return withSnapshotWriteDatabase(
    db,
    async (transactionDb) => {
      await (
        await import("~/server/workflows/runs/execution")
      ).assertWorkflowEffect(transactionDb);
      await assertAutomaticRuleOn(
        transactionDb,
        automatic.rule.key,
        automatic.rule.stamp,
        suggestionId,
      );
      if (automatic.statementScope) {
        const { statementLabelTargetsInScope } =
          await import("~/server/domains/transaction-import/repo/statement-suggestions");
        // This serializable write boundary must enforce the original selection
        // even when regeneration published valid evidence for another account.
        if (
          !(
            await statementLabelTargetsInScope(
              transactionDb,
              automatic.statementScope,
              [suggestionId],
            )
          ).has(suggestionId)
        )
          throw new Error(
            "Statement charge is outside the automatic application's scope",
          );
      }
      return settleReview(
        transactionDb,
        { ...context, db: transactionDb },
        input,
        automatic,
        emailScope,
      );
    },
    { isolationLevel: "serializable" },
  );
}

function assertReviewAction(
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

function assertApplicationFamily(
  family: SuggestionFamily,
  application: Review["application"],
) {
  if (!application) return;
  const expected = APPLICATION_FAMILIES[application.kind];
  if (expected.family !== family) throw new Error(expected.message);
}

async function settleReview(
  db: Database,
  context: EntityKernelContext,
  input: Review,
  automatic: AutomaticReview | null,
  emailScope?: EmailEvidenceWriteScope,
) {
  const authority = automatic ? "automatic" : "member";
  let prediction:
    | Pick<
        typeof suggestionTable.$inferSelect,
        | "id"
        | "family"
        | "subject"
        | "judgment"
        | "producer"
        | "evidence"
        | "fingerprint"
      >
    | undefined;
  if (input.suggestionId) {
    [prediction] = await getDb(db)
      .select({
        id: suggestionTable.id,
        fingerprint: suggestionTable.fingerprint,
        family: suggestionTable.family,
        subject: suggestionTable.subject,
        judgment: suggestionTable.judgment,
        producer: suggestionTable.producer,
        // Only field application consumes captured correction inputs; history must not load unrelated snapshots.
        evidence: sql`CASE WHEN ${suggestionTable.family} = ${suggestionFamily.enum.field} AND ${input.intent === "apply"} THEN ${suggestionTable.evidence} ELSE NULL END`,
      })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, input.suggestionId))
      .limit(1);
    // A mail decision's owner answers for its handle; carried rows kept their id.
    if (
      !prediction ||
      mailDecisionFamily.safeParse(prediction.family).success
    ) {
      const mail = await resolveMailDecisionHandle(db, input.suggestionId);
      if (mail) {
        if (automatic)
          throw new Error(
            `${mail.family} Suggestions have no Automatic rule; review them`,
          );
        assertApplicationFamily(mail.family, input.application);
        return settleMailDecisionReview(db, context, input, mail, emailScope);
      }
      prediction = undefined;
    }
  }
  if (!prediction) throw new Error("Suggestion not found");
  // Problems findings and grading rosters are resolved by their own paths.
  const name = prediction.family;
  if (!isReviewFamily(name))
    throw new Error(`${name} Suggestions are not reviewed as Suggestions`);
  const family = suggestionFamilies[name];
  (family.subject ?? suggestionSubjects[name]).parse(prediction.subject);
  assertReviewAction(name, input.verdict, automatic);
  if (
    prediction.subject.kind === "statement_transaction" &&
    input.suppression
  ) {
    const sourceState = await getDb(db).execute<{ held: boolean }>(
      sql`SELECT ${statementSuggestionSourceHeld("s")} AS held FROM "Suggestion" s WHERE s.id=${prediction.id}::uuid`,
      "objects",
    );
    if (sourceState[0]?.held) input = { ...input, suppression: null };
  }

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
  const writeReview = (transactionDb: Database) =>
    recordFeedbackWithInsertion(transactionDb, {
      ...input,
      suggestionId: prediction.id,
      authority,
      actorUserId: context.actorContext.userId,
      metadata: {
        kind: "assessment_review",
        application: input.application ?? null,
        expectedFingerprint: input.expectedFingerprint ?? null,
        ...(automatic && { rule: automatic.rule }),
      },
    });
  const publication = await withEmailReviewBoundary(
    db,
    prediction,
    writeReview,
    emailScope,
  );
  const event = publication.event;
  if (input.intent === "draft") {
    return {
      suggestionId: prediction.id,
      feedbackId: event.id,
      status: "draft",
      applied: false,
    };
  }
  if (input.intent === "apply") {
    const executeApplication = () => {
      const apply = async (transactionDb: Database) => {
        const outcome: z.infer<typeof suggestionReviewOut> = {
          suggestionId: prediction.id,
          feedbackId: event.id,
          status: "applied",
          applied: true,
        };
        // Serialize generic commands without taking projection locks ahead of the
        // domain's parent locks. Receipt and mutation commit in the same boundary.
        await getDb(transactionDb).execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`suggestion-review:${prediction.id}`},0))`,
        );
        const [owner] = await getDb(transactionDb)
          .select({ decisions: suggestionTable.decisions })
          .from(suggestionTable)
          .where(eq(suggestionTable.id, prediction.id));
        const receipt = decisionForOperation(
          prediction.id,
          owner?.decisions ?? [],
          `command-application:${input.operationId}`,
        );
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
        if (input.application?.kind === "saved_field") {
          await acknowledgeSavedField(transactionDb, context, prediction, {
            recordId: input.application.recordId,
            operationId: input.operationId,
            correction: input.correction,
            commandFeedback: event,
          });
        } else {
          if (prediction.family === "field") {
            const { assertConnectionFieldFresh } =
              await import("~/server/domains/connection/repo/field-connections");
            await assertConnectionFieldFresh(transactionDb, prediction.id);
          }
          if ("lockForApply" in family && family.lockForApply)
            await family.lockForApply(transactionDb, prediction);
          const query = getDb(transactionDb)
            .select(suggestionStateColumns)
            .from(suggestionTable)
            .where(eq(suggestionTable.id, prediction.id))
            .limit(1);
          // Two accepted reviews can race; serialize application on the Suggestion owner.
          const [state] =
            family.transactionBound !== false
              ? await query.for("update")
              : await query;
          if (!state?.active || state.status === "superseded")
            throw new Error(
              "Suggestion evidence is stale; request a fresh suggestion before applying",
            );
          if (
            state.status === "applied" ||
            (prediction.family === "field" && state.status !== "pending")
          )
            throw new Error(
              "Suggestion already resolved by another command; request a fresh suggestion",
            );
          if (
            input.expectedFingerprint !== undefined &&
            input.expectedFingerprint !==
              ("currentFingerprint" in family && family.currentFingerprint
                ? await family.currentFingerprint(transactionDb, state)
                : state.fingerprint)
          )
            throw new Error("Suggestion evidence fingerprint changed");
          (family.target ?? suggestionProjectionTargets[name]).parse(state);
          const applicationResult = await family.apply(
            transactionDb,
            { ...context, db: transactionDb, reviewFeedbackId: event.id },
            state,
            input,
            automatic,
          );
          if (applicationResult) outcome.applicationResult = applicationResult;
          if (family.transactionBound === false)
            await transitionSuggestionStates(
              transactionDb,
              and(
                eq(suggestionTable.id, state.id),
                eq(suggestionTable.active, true),
              ),
              { status: "applied" },
            );
        }
        let fieldApplicationReceipt: z.infer<
          typeof suggestionAcceptanceReceipt
        > | null = null;
        if (
          prediction.family === "field" &&
          authority === "member" &&
          input.correction.present
        ) {
          const [field] = await getDb(transactionDb)
            .select(suggestionStateColumns)
            .from(suggestionTable)
            .where(eq(suggestionTable.id, prediction.id))
            .limit(1);
          if (!field)
            throw new Error("Corrected field application has no saved lineage");
          fieldApplicationReceipt = {
            ...suggestionAcceptanceReceipt.parse(field.acceptanceReceipt),
            appliedInputFingerprint: await fieldInputFingerprint(
              transactionDb,
              field.entity,
              suggestionRecordId(field),
              field.field,
            ),
          };
        }
        await recordFeedback(transactionDb, {
          suggestionId: prediction.id,
          operationId: `command-application:${input.operationId}`,
          verdict: "ungraded",
          intent: "apply",
          authority,
          actorUserId: context.actorContext.userId,
          receipt: outcome,
          metadata: {
            kind: "assessment_application",
            commandFeedbackId: event.id,
            ...(fieldApplicationReceipt && { fieldApplicationReceipt }),
            ...(automatic && { rule: automatic.rule }),
          },
        });
        return outcome;
      };
      return withEmailReviewBoundary(
        db,
        prediction,
        (scopedDb) =>
          "isolationLevel" in family && family.isolationLevel === "serializable"
            ? withSnapshotWriteDatabase(scopedDb, apply, {
                isolationLevel: "serializable",
              })
            : withTransactionDatabase(scopedDb, apply),
        emailScope,
      );
    };
    return executeApplication();
  }
  const writeHistory = async (transactionDb: Database) => {
    const [state] = await getDb(transactionDb)
      .select({
        id: suggestionTable.id,
        active: suggestionTable.active,
        status: suggestionTable.status,
        data: suggestionTable.data,
      })
      .from(suggestionTable)
      .where(eq(suggestionTable.id, prediction.id))
      .for("update")
      .limit(1);
    if (state?.active && input.suppression) {
      if (!["dismissed", "wrong"].includes(input.verdict))
        throw new Error(
          "Only history Dismissal or Wrong Feedback accepts suppression scope",
        );
      await transitionSuggestionState(transactionDb, state.id, {
        suppression: input.suppression,
        status: "resolved",
      });
      return "resolved";
    } else if (
      state &&
      (state.active || prediction.family === "field") &&
      !["applied", "superseded"].includes(state.status) &&
      input.verdict !== "uncertain"
    ) {
      const nextStatus = input.verdict === "wrong" ? "rejected" : "resolved";
      const reviewKey =
        prediction.family === "field" && input.verdict === "wrong"
          ? z.object({ reviewKey: z.string().nullable() }).safeParse(state.data)
              .data?.reviewKey
          : null;
      await transitionSuggestionStates(
        transactionDb,
        or(
          eq(suggestionTable.id, state.id),
          reviewKey
            ? and(
                eq(suggestionTable.family, "field"),
                eq(suggestionTable.status, "pending"),
                sql`${suggestionTable.data}->>'reviewKey' = ${reviewKey}`,
              )
            : undefined,
        ),
        (row) => ({
          status: nextStatus,
          ...(reviewKey && {
            data: {
              ...stateDataObject.parse(row.data ?? {}),
              governingFeedbackId: event.id,
            },
          }),
          ...(input.correction.present && {
            correctValue: input.correction.value,
          }),
        }),
      );
      return nextStatus;
    }
    return state?.status ?? "historical";
  };
  const status = await withEmailReviewBoundary(
    db,
    prediction,
    (scopedDb) => withTransactionDatabase(scopedDb, writeHistory),
    emailScope,
  );
  return {
    suggestionId: prediction.id,
    feedbackId: event.id,
    status,
    applied: false,
  };
}
export async function reviewSuggestionBatch(
  db: Database,
  context: EntityKernelContext,
  raw: z.input<typeof suggestionReviewBatchInput>,
) {
  const { items } = suggestionReviewBatchInput.parse(raw);
  const results = [];
  for (const item of items) {
    try {
      results.push({
        ...(await reviewSuggestion(db, context, item)),
        ok: true as const,
      });
    } catch (error) {
      results.push({
        suggestionId: item.suggestionId ?? null,
        ok: false as const,
        error: getErrorMessage(error),
      });
    }
  }
  return results;
}
