import {
  assessmentReviewInput,
  assessmentReviewBatchInput,
  assessmentSubjects,
  assessmentJudgments,
  assessmentProjectionTargets,
  assessmentReviewOut,
  type AssessmentFamily,
} from "@cubby/schemas/assessment";
import { correctEmailRelevanceInput } from "@cubby/schemas/email-actions";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { getErrorMessage } from "@cubby/shared";
import { and, eq, or, sql } from "drizzle-orm";
import { isEqual } from "es-toolkit";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  runAfterCommit,
  withTransactionDatabase,
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
import { runMutationSideEffects } from "~/server/entity-kernel/repo/mutation-side-effects";
import {
  assertApplicationReceipt,
  publishAssessment,
  recordFeedback,
} from "~/server/generic/assessment/repo/assessment";
import { acknowledgeSavedField } from "~/server/generic/assessment/repo/assessment-field-receipt";
import {
  acceptSuggestion,
  applyFieldCorrection,
} from "~/server/generic/assessment/repo/suggestion-review";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

type Review = z.infer<typeof assessmentReviewInput>;
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
  apply: (
    db: Database,
    context: EntityKernelContext,
    state: typeof assessmentState.$inferSelect,
    input: Review,
  ) => Promise<void>;
};
/** Each family validates its own subject and uses its transaction-bound domain mutation. */
const assessmentFamilies = {
  field: {
    subject: assessmentSubjects.field,
    target: assessmentProjectionTargets.field,
    transactionBound: true,
    actions: ["correct", "wrong", "uncertain", "dismissed"],
    apply: async (db, context, state, input) => {
      if (input.verdict === "correct" && !input.correction.present)
        await acceptSuggestion(db, context, { id: state.id });
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
        .select()
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
        await import("~/server/domains/purchase-import/gmail/relevance-correction");
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
        await import("~/server/domains/purchase-import/email-purchase-decision");
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
      await getDb(db)
        .update(assessmentState)
        .set({ confirmedValue: null })
        .where(
          and(
            eq(assessmentState.family, "image_description"),
            eq(assessmentState.recordId, state.recordId),
            sql`${assessmentState.id} <> ${state.id}`,
          ),
        );
      await getDb(db)
        .update(assessmentState)
        .set({ confirmedValue: correction, status: "applied" })
        .where(eq(assessmentState.id, state.id));
      await runAfterCommit(db, (committedDb) =>
        runMutationSideEffects(committedDb, {
          entity: {
            entity: "image",
            id: parseEntityId("image", state.recordId),
          },
          action: "updated",
          source: "image-feedback",
        }),
      );
    },
  },
  product_pair: {
    subject: assessmentSubjects.product_pair,
    target: assessmentProjectionTargets.product_pair,
    transactionBound: false,
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
        await import("~/server/domains/product/service/product-match.service");
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
  recommendation: {
    subject: assessmentSubjects.recommendation,
    target: assessmentProjectionTargets.recommendation,
    transactionBound: true,
    actions: ["wrong", "uncertain", "dismissed"],
    apply: async () => {
      throw new Error("Recommendation Feedback has no domain application");
    },
  },
} satisfies Record<AssessmentFamily, Handler>;

/** History settles first. A stale or refused application cannot erase the review. */
export async function reviewAssessment(
  db: Database,
  context: EntityKernelContext,
  raw: z.input<typeof assessmentReviewInput>,
) {
  const input = assessmentReviewInput.parse(raw);
  let prediction: typeof assessment.$inferSelect | undefined;
  if (input.assessmentId)
    [prediction] = await getDb(db)
      .select()
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
  const family = assessmentFamilies[prediction.family];
  family.subject.parse(prediction.subject);
  if (!family.actions.some((action) => action === input.verdict))
    throw new Error(
      `Unsupported ${prediction.family} review action ${input.verdict}`,
    );
  if (input.suppression) {
    if (input.verdict !== "dismissed" || input.intent !== "history")
      throw new Error("Suppression requires presentation-only Dismissal");
    if (prediction.subject.kind === "recommendation") {
      if (
        input.suppression.scope !== prediction.subject.scope ||
        input.suppression.candidateKey !== prediction.subject.candidateKey
      )
        throw new Error(
          "Suppression differs from the declared recommendation scope",
        );
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
  if (input.intent === "draft" && prediction.family !== "field")
    throw new Error("Only field Assessments support draft acceptance");
  if (
    input.application?.kind === "saved_field" &&
    prediction.family !== "field"
  )
    throw new Error("Saved-field receipts require a field Assessment");
  if (
    input.application?.kind === "product_merge" &&
    prediction.family !== "product_pair"
  )
    throw new Error(
      "Product merge application requires a Product pair Assessment",
    );
  if (input.intent === "apply" && prediction.family === "email_relevance") {
    const subject = assessmentSubjects.email_relevance.parse(
      prediction.subject,
    );
    emailRelevanceApplication(subject, input);
  }
  if (input.correction.present) {
    if (prediction.family === "email_link")
      assessmentJudgments.email_link.parse(input.correction.value);
    if (prediction.family === "email_relevance")
      z.enum(["related", "unrelated", "uncertain"]).parse(
        input.correction.value,
      );
    if (prediction.family === "image_description")
      z.string().parse(input.correction.value);
  }
  const event = await recordFeedback(db, {
    ...input,
    assessmentId: prediction.id,
    authority: "member",
    actorUserId: context.actorContext.userId,
    metadata: {
      kind: "assessment_review",
      application: input.application ?? null,
      expectedFingerprint: input.expectedFingerprint ?? null,
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
    const outcome = {
      assessmentId: prediction.id,
      feedbackId: event.id,
      status: "applied",
      applied: true,
    };
    return withTransactionDatabase(db, async (transactionDb) => {
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
        if (!isEqual(assessmentReviewOut.parse(receipt.receipt), outcome))
          throw new Error(
            "Application receipt does not match this command outcome",
          );
        return outcome;
      }
      if (input.application?.kind === "saved_field") {
        await acknowledgeSavedField(transactionDb, context, prediction, {
          recordId: input.application.recordId,
          operationId: input.operationId,
          correction: input.correction,
          commandFeedback: event,
        });
      } else {
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
          input.expectedFingerprint !== state.fingerprint
        )
          throw new Error("Assessment evidence fingerprint changed");
        family.target.parse(state);
        await family.apply(
          transactionDb,
          { ...context, db: transactionDb },
          state,
          input,
        );
        if (!family.transactionBound)
          await getDb(transactionDb)
            .update(assessmentState)
            .set({ status: "applied" })
            .where(
              and(
                eq(assessmentState.id, state.id),
                eq(assessmentState.active, true),
              ),
            );
      }
      await recordFeedback(transactionDb, {
        assessmentId: prediction.id,
        operationId: `command-application:${input.operationId}`,
        verdict: "ungraded",
        intent: "apply",
        authority: "member",
        actorUserId: context.actorContext.userId,
        receipt: outcome,
        metadata: {
          kind: "assessment_application",
          commandFeedbackId: event.id,
        },
      });
      return outcome;
    });
  }
  const status = await withTransactionDatabase(db, async (transactionDb) => {
    const [state] = await getDb(transactionDb)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, prediction.id))
      .for("update")
      .limit(1);
    if (state?.active && input.suppression) {
      if (input.verdict !== "dismissed")
        throw new Error(
          "Only presentation Dismissal accepts suppression scope",
        );
      await getDb(transactionDb)
        .update(assessmentState)
        .set({ suppression: input.suppression, status: "resolved" })
        .where(eq(assessmentState.id, state.id));
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
      await getDb(transactionDb)
        .update(assessmentState)
        .set({
          status: nextStatus,
          ...(reviewKey
            ? {
                data: sql`COALESCE(${assessmentState.data}, '{}'::jsonb) || jsonb_build_object('governingFeedbackId', ${event.id}::text)`,
              }
            : {}),
          ...(input.correction.present
            ? { correctValue: input.correction.value }
            : {}),
        })
        .where(
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
