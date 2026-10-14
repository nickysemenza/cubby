import {
  assessmentReviewInput,
  assessmentReviewBatchInput,
  assessmentSubjects,
  type AssessmentFamily,
} from "@cubby/schemas/assessment";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { getErrorMessage } from "@cubby/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  assessment,
  assessmentState,
  email,
  purchase,
  image,
} from "~/server/db/schema";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { publishAssessment, recordFeedback } from "~/server/repo/assessment";
import { acknowledgeSavedField } from "~/server/repo/assessment-field-receipt";
import {
  getDb,
  notDeleted,
  runAfterCommit,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  acceptSuggestion,
  applyFieldCorrection,
} from "~/server/repo/suggestion-review";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";

type Review = z.infer<typeof assessmentReviewInput>;
type Handler = {
  subject: z.ZodType;
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
export const assessmentFamilies = {
  field: {
    subject: assessmentSubjects.field,
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
      if (!subject.checksum || !input.correction.present)
        throw new Error(
          "Email relevance application requires a current checksum and correction",
        );
      const classification = z
        .enum(["related", "uncertain"])
        .parse(input.correction.value);
      const [source] = await getDb(db)
        .select({ code: email.shortcode })
        .from(email)
        .where(eq(email.id, parseEntityId("email", subject.recordId)))
        .limit(1);
      if (!source) throw new Error("Email no longer exists");
      const { correctEmailRelevance } =
        await import("~/server/purchase-import/gmail/relevance-correction");
      await correctEmailRelevance(
        db,
        {
          id: parseShortcodeFor("email", source.code),
          expectedChecksum: subject.checksum,
          reviewedChecksum: subject.checksum,
          classification,
          reason: input.reason ?? "Member reviewed the Assessment",
        },
        context.actorContext,
      );
    },
  },
  email_link: {
    subject: assessmentSubjects.email_link,
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
      const [target] = await getDb(db)
        .select({ code: purchase.shortcode })
        .from(purchase)
        .where(eq(purchase.id, parseEntityId("purchase", subject.purchaseId)))
        .limit(1);
      if (!mail || !target)
        throw new Error("Email link target no longer exists");
      const { decideEmailPurchase } =
        await import("~/server/purchase-import/email-purchase-decision");
      await decideEmailPurchase(
        db,
        {
          id: parseShortcodeFor("email", mail.code),
          purchaseId: parseShortcodeFor("purchase", target.code),
          expectedChecksum: subject.checksum,
          decision: input.verdict === "correct" ? "linked" : "dismissed",
        },
        context.actorContext,
      );
    },
  },
  image_description: {
    subject: assessmentSubjects.image_description,
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
        await import("~/server/services/product-match.service");
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
    if (prediction.family !== "field")
      throw new Error("Only field Assessments support draft acceptance");
    return {
      assessmentId: prediction.id,
      feedbackId: event.id,
      status: "draft",
      applied: false,
    };
  }
  if (input.intent === "apply" && input.application?.kind === "saved_field") {
    if (prediction.family !== "field")
      throw new Error("Saved-field receipts require a field Assessment");
    await acknowledgeSavedField(db, context, prediction, {
      recordId: input.application.recordId,
      operationId: input.operationId,
      correction: input.correction,
    });
    return {
      assessmentId: prediction.id,
      feedbackId: event.id,
      status: "applied",
      applied: true,
    };
  }
  if (input.intent === "apply" && !family.transactionBound) {
    const [state] = await getDb(db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, prediction.id))
      .limit(1);
    if (
      !state ||
      (prediction.family !== "product_pair" &&
        (!state.active || state.status === "superseded"))
    )
      throw new Error(
        "Assessment evidence is stale; request a fresh assessment",
      );
    await family.apply(db, context, state, input);
    return {
      assessmentId: prediction.id,
      feedbackId: event.id,
      status: "applied",
      applied: true,
    };
  }
  const status = await withTransactionDatabase(db, async (transactionDb) => {
    const [state] = await getDb(transactionDb)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, prediction.id))
      .for("update")
      .limit(1);
    if (input.intent === "apply") {
      if (!state?.active || state.status === "superseded")
        throw new Error(
          "Assessment evidence is stale; request a fresh assessment before applying",
        );
      if (
        input.expectedFingerprint !== undefined &&
        input.expectedFingerprint !== state.fingerprint
      )
        throw new Error("Assessment evidence fingerprint changed");
      if (state.status === "applied") return state.status;
      await family.apply(
        transactionDb,
        { ...context, db: transactionDb },
        state,
        input,
      );
      return "applied";
    }
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
      state?.active &&
      !["applied", "superseded"].includes(state.status) &&
      input.verdict !== "uncertain"
    ) {
      const nextStatus = input.verdict === "wrong" ? "rejected" : "resolved";
      await getDb(transactionDb)
        .update(assessmentState)
        .set({
          status: nextStatus,
          ...(input.correction.present
            ? { correctValue: input.correction.value }
            : {}),
        })
        .where(eq(assessmentState.id, state.id));
      return nextStatus;
    }
    return state?.status ?? "historical";
  });
  return {
    assessmentId: prediction.id,
    feedbackId: event.id,
    status,
    applied: input.intent === "apply",
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
