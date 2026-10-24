import { suggestionAcceptanceReceipt } from "@cubby/schemas/ai-evaluation";
import {
  assessmentReviewInput,
  assessmentReviewBatchInput,
  assessmentSubjects,
  assessmentJudgments,
  assessmentProjectionTargets,
  assessmentReviewOut,
  type AssessmentFamily,
} from "@cubby/schemas/assessment";
import {
  AUTOMATIC_RULE_FAMILIES,
  type AutomaticRuleKey,
} from "@cubby/schemas/automatic-rule";
import { correctEmailRelevanceInput } from "@cubby/schemas/email-actions";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { statementTransactionApplication } from "@cubby/schemas/statement-suggestion";
import { getErrorMessage } from "@cubby/shared";
import { and, eq, or, sql } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
  withSnapshotWriteDatabase,
} from "~/server/db/helpers";
import {
  assessment,
  assessmentState,
  feedback,
  email,
  purchase,
  image,
} from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  assertApplicationReceipt,
  publishAssessment,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";
import { acknowledgeSavedField } from "~/server/generic/assessment/repo/assessment-field-receipt";
import {
  transitionAssessmentState,
  transitionAssessmentStates,
} from "~/server/generic/assessment/repo/assessment-state";
import { fieldCorrectionKey } from "~/server/generic/assessment/repo/correction-sources";
import { lockFieldCorrectionKey } from "~/server/generic/assessment/repo/field-correction-lock";
import { resolveFieldCorrection } from "~/server/generic/assessment/repo/field-correction-resolver";
import { fieldInputFingerprint } from "~/server/generic/assessment/repo/field-input-fence";
import {
  acceptSuggestion,
  applyFieldCorrection,
} from "~/server/generic/assessment/repo/suggestion-review";
import { recordChange } from "~/server/generic/changes/repo/change";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { isReviewFamily, type ReviewFamily } from "./review-families";

const stateDataObject = z.record(z.string(), z.json());

type Review = z.infer<typeof assessmentReviewInput>;

/**
 * Internal only, set by `applyAutomaticRules` with the system actor: no
 * public schema carries it. It records `automatic` Feedback naming the rule.
 */
export type AutomaticReview = {
  authority: "automatic";
  rule: { key: AutomaticRuleKey; revision: string; stamp: string };
};
const automaticReviewInput = assessmentReviewInput.extend({
  operationId: z.string().regex(/^automatic:/),
});
function emailRelevanceApplication(
  subject: z.infer<typeof assessmentSubjects.email_relevance>,
  input: Review,
) {
  if (!input.correction.present)
    throw new Error(
      "Email relevance application requires a current checksum and correction",
    );
  return correctEmailRelevanceInput.omit({ id: true }).parse({
    expectedChecksum: subject.checksum,
    reviewedChecksum: subject.checksum,
    classification: input.correction.value,
    reason: input.reason ?? "Member reviewed the Assessment",
  });
}
type Handler = {
  subject: z.ZodType;
  target: z.ZodType;
  actions: readonly Review["verdict"][];
  transactionBound: boolean;
  /** Snapshot-dependent domain planning owns the outer retry boundary. */
  isolationLevel?: "serializable";
  /** Domain parent locks must precede the suggestion's projection row lock. */
  lockForApply?: (
    db: Database,
    prediction: Pick<typeof assessment.$inferSelect, "subject" | "judgment">,
  ) => Promise<void>;
  /** The fingerprint a review must match; defaults to the stored one. */
  currentFingerprint?: (
    db: Database,
    state: typeof assessmentState.$inferSelect,
  ) => Promise<string | null>;
  apply: (
    db: Database,
    context: EntityKernelContext,
    state: typeof assessmentState.$inferSelect,
    input: Review,
    automatic: AutomaticReview | null,
  ) => Promise<z.infer<typeof assessmentReviewOut>["applicationResult"] | void>;
};
/** Each family validates its own subject and uses its transaction-bound domain mutation. */
const assessmentFamilies = {
  field: {
    subject: assessmentSubjects.field,
    target: assessmentProjectionTargets.field,
    transactionBound: true,
    actions: ["correct", "wrong", "uncertain", "dismissed"],
    apply: async (db, context, state, input, automatic) => {
      // The automatic mode keeps acceptSuggestion's requiresSuggestionReview refusal.
      if (input.verdict === "correct" && !input.correction.present)
        await acceptSuggestion(
          db,
          context,
          { id: state.id },
          automatic
            ? { mode: "automatic", confidence: state.confidence }
            : undefined,
        );
      else if (input.correction.present)
        await applyFieldCorrection(db, context, {
          id: state.id,
          correctValue: input.correction.value,
        });
      else
        throw new Error(
          "Applying field Feedback requires acceptance or a correction",
        );
    },
  },
  email_relevance: {
    subject: assessmentSubjects.email_relevance,
    target: assessmentProjectionTargets.email_relevance,
    transactionBound: false,
    actions: ["correct", "wrong", "uncertain"],
    apply: async (db, context, state, input) => {
      const [prediction] = await getDb(db)
        .select({ subject: assessment.subject })
        .from(assessment)
        .where(eq(assessment.id, state.id))
        .limit(1);
      const subject = assessmentSubjects.email_relevance.parse(
        prediction?.subject,
      );
      const correction = emailRelevanceApplication(subject, input);
      const [source] = await getDb(db)
        .select({ code: email.shortcode })
        .from(email)
        .where(eq(email.id, parseEntityId("email", subject.recordId)))
        .limit(1);
      if (!source) throw new Error("Email no longer exists");
      const { correctEmailRelevance } =
        await import("~/server/domains/purchase-import/repo/gmail/relevance-correction");
      await correctEmailRelevance(
        db,
        {
          id: parseShortcodeFor("email", source.code),
          ...correction,
        },
        context.actorContext,
      );
    },
  },
  mail_import_outcome: {
    subject: assessmentSubjects.mail_import_outcome,
    target: assessmentProjectionTargets.mail_import_outcome,
    transactionBound: true,
    actions: ["correct", "wrong", "uncertain", "ungraded"],
    apply: async () => {
      throw new Error(
        "Mail import outcome grades are history only; use the domain tools to correct a Purchase or Email",
      );
    },
  },
  email_link: {
    subject: assessmentSubjects.email_link,
    target: assessmentProjectionTargets.email_link,
    transactionBound: false,
    actions: ["correct", "wrong", "dismissed"],
    apply: async (db, context, state, input) => {
      const [prediction] = await getDb(db)
        .select()
        .from(assessment)
        .where(eq(assessment.id, state.id))
        .limit(1);
      const subject = assessmentSubjects.email_link.parse(prediction?.subject);
      if (!subject.recordId)
        throw new Error("Historical Email event has no current Email target");
      const [mail] = await getDb(db)
        .select({ code: email.shortcode })
        .from(email)
        .where(eq(email.id, parseEntityId("email", subject.recordId)))
        .limit(1);
      const currentTarget = z
        .object({ purchaseId: z.uuid() })
        .parse(state.data);
      const decision = assessmentJudgments.email_link.parse(
        input.correction.present
          ? input.correction.value
          : prediction?.judgment,
      ).decision;
      const [target] = await getDb(db)
        .select({ code: purchase.shortcode })
        .from(purchase)
        .where(
          and(
            eq(
              purchase.id,
              parseEntityId("purchase", currentTarget.purchaseId),
            ),
            notDeleted(purchase),
          ),
        )
        .limit(1);
      if (!mail || !target)
        throw new Error("Email link target no longer exists");
      const { decideEmailPurchase } =
        await import("~/server/domains/purchase-import/repo/email-purchase-decision");
      await decideEmailPurchase(
        db,
        {
          id: parseShortcodeFor("email", mail.code),
          purchaseId: parseShortcodeFor("purchase", target.code),
          expectedChecksum: subject.checksum,
          decision,
        },
        context.actorContext,
        {
          eventId: subject.eventId,
          originalId: subject.originalId,
          expectedAssessmentId: state.id,
        },
      );
    },
  },
  image_description: {
    subject: assessmentSubjects.image_description,
    target: assessmentProjectionTargets.image_description,
    transactionBound: true,
    actions: ["correct", "wrong", "uncertain"],
    apply: async (db, _context, state, input) => {
      const correction = input.correction.present
        ? input.correction
        : {
            present: true as const,
            value: z.json().parse(state.suggestedValue),
          };
      if (typeof correction.value !== "string")
        throw new Error("Confirmed image description must be text");
      const [source] = await getDb(db)
        .select({ hash: image.sha256 })
        .from(image)
        .where(and(eq(image.id, state.recordId), notDeleted(image)))
        .for("update")
        .limit(1);
      if (!source || state.fingerprint !== source.hash)
        throw new Error("Image evidence changed before confirmation");
      const cause = { kind: "image_description_confirmed" };
      await transitionAssessmentStates(
        db,
        and(
          eq(assessmentState.family, "image_description"),
          eq(assessmentState.recordId, state.recordId),
          sql`${assessmentState.id} <> ${state.id}`,
        ),
        { confirmedValue: null },
        cause,
      );
      await transitionAssessmentState(
        db,
        state.id,
        { confirmedValue: correction, status: "applied" },
        cause,
      );
      await recordChange(db, { kind: "source", categories: ["image"] });
    },
  },
  product_pair: {
    subject: assessmentSubjects.product_pair,
    target: assessmentProjectionTargets.product_pair,
    transactionBound: false,
    currentFingerprint: async (db, state) => {
      const { reviewedProductPairFingerprint } =
        await import("~/server/domains/product/repo/match/product-match-candidate");
      return reviewedProductPairFingerprint(db, state);
    },
    actions: ["correct", "wrong", "uncertain", "dismissed"],
    apply: async (db, context, state, input) => {
      if (input.verdict !== "correct" || input.correction.present)
        throw new Error("Product merging requires an accepted pair");
      if (
        input.application?.kind !== "product_merge" ||
        !input.expectedFingerprint
      )
        throw new Error(
          "Product merging requires a survivor and the current pair fingerprint",
        );
      const { mergeProductMatch } =
        await import("~/server/domains/product/repo/match/product-match-review");
      await mergeProductMatch(
        { ...context, db },
        {
          keepId: input.application.keepId,
          mergeId: input.application.mergeId,
          assessmentId: state.id,
          expectedFingerprint: input.expectedFingerprint,
        },
      );
    },
  },
  statement_transaction: {
    isolationLevel: "serializable",
    subject: assessmentSubjects.statement_transaction,
    target: assessmentProjectionTargets.statement_transaction,
    // The domain write appends settlement refs, which supersede pending
    // suggestions by trigger; the handler marks its own state applied first.
    transactionBound: true,
    lockForApply: async (db, prediction) => {
      const judgment = assessmentJudgments.statement_transaction.parse(
        prediction.judgment,
      );
      const subject = assessmentSubjects.statement_transaction.parse(
        prediction.subject,
      );
      const { lockTransferPairLegs } =
        await import("~/server/domains/financial-transaction/repo/transfer-pair-suggestions");
      // Even a prediction made before pair discovery shares its charge's leg
      // lock with a later pair apply, before either can hold its projection.
      await lockTransferPairLegs(
        db,
        judgment.transferPair?.key ??
          `stmt:${subject.source}:${subject.chargeKey}`,
      );
    },
    actions: ["correct", "wrong", "uncertain", "dismissed"],
    apply: async (db, context, state, input) => {
      if (input.application?.kind !== "statement_transaction")
        throw new Error(
          "Applying a Transaction suggestion requires the chosen statement action",
        );
      const { applyStatementTransactionSuggestion } =
        await import("~/server/domains/transaction-import/repo/statement-suggestion-apply");
      await applyStatementTransactionSuggestion(db, context, state, {
        application: input.application,
        corrected: input.correction.present,
      });
    },
  },
  transfer_pair: {
    subject: assessmentSubjects.transfer_pair,
    target: assessmentProjectionTargets.transfer_pair,
    transactionBound: true,
    lockForApply: async (db, prediction) => {
      const subject = assessmentSubjects.transfer_pair.parse(
        prediction.subject,
      );
      const { lockTransferPairLegs } =
        await import("~/server/domains/financial-transaction/repo/transfer-pair-suggestions");
      await lockTransferPairLegs(db, subject.pairKey);
    },
    actions: ["correct", "wrong", "uncertain", "dismissed"],
    apply: async (db, context, state, input, automatic) => {
      if (
        automatic ||
        input.verdict !== "correct" ||
        input.correction.present ||
        input.application?.kind !== "transfer_pair"
      )
        throw new Error(
          "Transfer pairing requires member acceptance of the current pair.",
        );
      const { applyTransferPairSuggestion } =
        await import("~/server/domains/financial-transaction/repo/transfer-pair-suggestions");
      await applyTransferPairSuggestion(db, context, state, input);
    },
  },
  recommendation: {
    subject: assessmentSubjects.recommendation,
    target: assessmentProjectionTargets.recommendation,
    transactionBound: false,
    actions: ["correct", "wrong", "uncertain", "dismissed"],
    apply: async (db, context, state, input) => {
      const [prediction] = await getDb(db)
        .select({ subject: assessment.subject })
        .from(assessment)
        .where(eq(assessment.id, state.id))
        .limit(1);
      const subject = assessmentSubjects.recommendation.parse(
        prediction?.subject,
      );
      if (subject.scope === "product.tag-propagation") {
        if (input.verdict !== "correct" || input.correction.present)
          throw new Error(
            "Tag additions require acceptance of the current proposal",
          );
        const { applyTagSuggestion } = await import("./tag-suggestions");
        await applyTagSuggestion(db, context, state);
        return;
      }
      const { applyEntityConnection } =
        await import("~/server/domains/connection/repo/entity-connections");
      return applyEntityConnection(db, context, state, input);
    },
  },
} satisfies Record<ReviewFamily, Handler>;

/**
 * History settles first. A stale or refused application cannot erase the
 * review. An automatic application is the exception: nobody reviewed it, so
 * a refusal leaves no Feedback at all.
 */
export async function reviewAssessment(
  db: Database,
  context: EntityKernelContext,
  raw: z.input<typeof assessmentReviewInput>,
  automatic?: AutomaticReview,
) {
  if (!automatic)
    return settleReview(db, context, assessmentReviewInput.parse(raw), null);
  const input = automaticReviewInput.parse(raw);
  if (
    !input.assessmentId ||
    input.verdict !== "correct" ||
    input.intent !== "apply" ||
    input.correction.present ||
    input.suppression
  )
    throw new Error("An Automatic rule only accepts an Assessment as is");
  const assessmentId = input.assessmentId;
  const { assertAutomaticRuleOn } =
    await import("~/server/generic/assessment/repo/automatic-rule-runtime");
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
        assessmentId,
      );
      return settleReview(
        transactionDb,
        { ...context, db: transactionDb },
        input,
        automatic,
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
    throw new Error(`${name} Assessments have no Automatic rule; review them`);
  if (!assessmentFamilies[name].actions.some((action) => action === verdict))
    throw new Error(`Unsupported ${name} review action ${verdict}`);
}

const APPLICATION_FAMILIES = {
  saved_field: {
    family: "field",
    message: "Saved-field receipts require a field Assessment",
  },
  product_merge: {
    family: "product_pair",
    message: "Product merge application requires a Product pair Assessment",
  },
  statement_transaction: {
    family: "statement_transaction",
    message:
      "Statement application requires a Transaction suggestion Assessment",
  },
  transfer_pair: {
    family: "transfer_pair",
    message: "Transfer-pair application requires a transfer-pair Assessment.",
  },
} satisfies Record<
  NonNullable<Review["application"]>["kind"],
  { family: AssessmentFamily; message: string }
>;

function assertApplicationFamily(
  family: AssessmentFamily,
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
) {
  const authority = automatic ? "automatic" : "member";
  let prediction:
    | Pick<
        typeof assessment.$inferSelect,
        "id" | "family" | "subject" | "judgment" | "producer" | "evidence"
      >
    | undefined;
  if (input.assessmentId)
    [prediction] = await getDb(db)
      .select({
        id: assessment.id,
        family: assessment.family,
        subject: assessment.subject,
        judgment: assessment.judgment,
        producer: assessment.producer,
        evidence: assessment.evidence,
      })
      .from(assessment)
      .where(eq(assessment.id, input.assessmentId))
      .limit(1);
  else {
    if (
      !input.standalone ||
      !input.correction.present ||
      typeof input.correction.value !== "string"
    )
      throw new Error(
        "Standalone image confirmation requires an Image and corrected description",
      );
    const imageId = await resolveOrThrow(db, "image", input.standalone.id);
    const [source] = await getDb(db)
      .select({ hash: image.sha256 })
      .from(image)
      .where(and(eq(image.id, imageId), notDeleted(image)))
      .limit(1);
    if (!source) throw new Error("Image not found");
    prediction = await publishAssessment(db, {
      publicationKey: `image-confirmation:${context.actorContext.userId}:${input.operationId}`,
      family: "image_description",
      subject: {
        kind: "image_description",
        entity: "image",
        recordId: imageId,
        contentHash: source.hash,
      },
      judgment: null,
      producer: null,
      fingerprint: source.hash,
      evidence: input.evidence,
    });
  }
  if (!prediction) throw new Error("Assessment not found");
  // Problems findings and grading rosters are resolved by their own paths.
  const name = prediction.family;
  if (!isReviewFamily(name))
    throw new Error(`${name} Assessments are not reviewed as Suggestions`);
  const family = assessmentFamilies[name];
  family.subject.parse(prediction.subject);
  assertReviewAction(name, input.verdict, automatic);
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
        "This Assessment does not declare a presentation suppression scope",
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
  if (input.intent !== "history" && prediction.family === "mail_import_outcome")
    throw new Error("Mail import outcome grades are history only");
  if (input.intent === "draft" && prediction.family !== "field")
    throw new Error("Only field Assessments support draft acceptance");
  assertApplicationFamily(prediction.family, input.application);
  if (input.intent === "apply" && prediction.family === "email_relevance") {
    const subject = assessmentSubjects.email_relevance.parse(
      prediction.subject,
    );
    emailRelevanceApplication(subject, input);
  }
  if (input.correction.present) {
    if (prediction.family === "mail_import_outcome")
      assessmentJudgments.mail_import_outcome.parse(input.correction.value);
    if (prediction.family === "email_link")
      assessmentJudgments.email_link.parse(input.correction.value);
    if (prediction.family === "email_relevance")
      z.enum(["related", "unrelated", "uncertain"]).parse(
        input.correction.value,
      );
    if (prediction.family === "image_description")
      z.string().parse(input.correction.value);
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
  const event = await recordFeedback(db, {
    ...input,
    assessmentId: prediction.id,
    authority,
    actorUserId: context.actorContext.userId,
    metadata: {
      kind: "assessment_review",
      application: input.application ?? null,
      expectedFingerprint: input.expectedFingerprint ?? null,
      ...(automatic && { rule: automatic.rule }),
    },
  });
  if (input.intent === "draft") {
    return {
      assessmentId: prediction.id,
      feedbackId: event.id,
      status: "draft",
      applied: false,
    };
  }
  if (input.intent === "apply") {
    const outcome: z.infer<typeof assessmentReviewOut> = {
      assessmentId: prediction.id,
      feedbackId: event.id,
      status: "applied",
      applied: true,
    };
    const apply = async (transactionDb: Database) => {
      // Serialize generic commands without taking projection locks ahead of the
      // domain's parent locks. Receipt and mutation commit in the same boundary.
      await getDb(transactionDb).execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`assessment-review:${prediction.id}`},0))`,
      );
      const [receipt] = await getDb(transactionDb)
        .select()
        .from(feedback)
        .where(
          and(
            eq(feedback.assessmentId, prediction.id),
            eq(
              feedback.operationId,
              `command-application:${input.operationId}`,
            ),
          ),
        )
        .limit(1);
      if (receipt) {
        assertApplicationReceipt(receipt, event, "assessment_application");
        const priorOutcome = assessmentReviewOut.parse(receipt.receipt);
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
      const correctionKey =
        prediction.family === "field"
          ? fieldCorrectionKey(prediction.evidence)
          : null;
      if (correctionKey) {
        await lockFieldCorrectionKey(transactionDb, correctionKey);
        if (
          automatic &&
          (await resolveFieldCorrection(transactionDb, correctionKey)).kind !==
            "none"
        )
          throw new Error(
            "A confirmed member correction requires correction propagation",
          );
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
          .select()
          .from(assessmentState)
          .where(eq(assessmentState.id, prediction.id))
          .limit(1);
        const [state] = family.transactionBound
          ? await query.for("update")
          : await query;
        if (!state?.active || state.status === "superseded")
          throw new Error(
            "Assessment evidence is stale; request a fresh assessment before applying",
          );
        if (
          state.status === "applied" ||
          (prediction.family === "field" && state.status !== "pending")
        )
          throw new Error(
            "Assessment already resolved by another command; request a fresh assessment",
          );
        if (
          input.expectedFingerprint !== undefined &&
          input.expectedFingerprint !==
            ("currentFingerprint" in family && family.currentFingerprint
              ? await family.currentFingerprint(transactionDb, state)
              : state.fingerprint)
        )
          throw new Error("Assessment evidence fingerprint changed");
        family.target.parse(state);
        const applicationResult = await family.apply(
          transactionDb,
          { ...context, db: transactionDb },
          state,
          input,
          automatic,
        );
        if (applicationResult) outcome.applicationResult = applicationResult;
        if (!family.transactionBound)
          await transitionAssessmentStates(
            transactionDb,
            and(
              eq(assessmentState.id, state.id),
              eq(assessmentState.active, true),
            ),
            { status: "applied" },
            { kind: "assessment_applied", feedbackId: event.id },
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
          .select()
          .from(assessmentState)
          .where(eq(assessmentState.id, prediction.id))
          .limit(1);
        if (!field)
          throw new Error("Corrected field application has no saved lineage");
        fieldApplicationReceipt = {
          ...suggestionAcceptanceReceipt.parse(field.acceptanceReceipt),
          appliedInputFingerprint: await fieldInputFingerprint(
            transactionDb,
            field.entity,
            field.recordId,
            field.field,
          ),
        };
      }
      await recordFeedback(transactionDb, {
        assessmentId: prediction.id,
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
    return "isolationLevel" in family &&
      family.isolationLevel === "serializable"
      ? withSnapshotWriteDatabase(db, apply, { isolationLevel: "serializable" })
      : withTransactionDatabase(db, apply);
  }
  const status = await withTransactionDatabase(db, async (transactionDb) => {
    const [state] = await getDb(transactionDb)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, prediction.id))
      .for("update")
      .limit(1);
    if (state?.active && input.suppression) {
      if (!["dismissed", "wrong"].includes(input.verdict))
        throw new Error(
          "Only history Dismissal or Wrong Feedback accepts suppression scope",
        );
      await transitionAssessmentState(
        transactionDb,
        state.id,
        { suppression: input.suppression, status: "resolved" },
        { kind: "member_review", feedbackId: event.id },
      );
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
      await transitionAssessmentStates(
        transactionDb,
        or(
          eq(assessmentState.id, state.id),
          reviewKey
            ? and(
                eq(assessmentState.family, "field"),
                eq(assessmentState.status, "pending"),
                sql`${assessmentState.data}->>'reviewKey' = ${reviewKey}`,
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
        { kind: "member_review", feedbackId: event.id },
      );
      return nextStatus;
    }
    return state?.status ?? "historical";
  });
  return {
    assessmentId: prediction.id,
    feedbackId: event.id,
    status,
    applied: false,
  };
}
export async function reviewAssessmentBatch(
  db: Database,
  context: EntityKernelContext,
  raw: z.input<typeof assessmentReviewBatchInput>,
) {
  const { items } = assessmentReviewBatchInput.parse(raw);
  const results = [];
  for (const item of items) {
    try {
      results.push({
        ...(await reviewAssessment(db, context, item)),
        ok: true as const,
      });
    } catch (error) {
      results.push({
        assessmentId: item.assessmentId ?? null,
        ok: false as const,
        error: getErrorMessage(error),
      });
    }
  }
  return results;
}
