import {
  assessmentJudgments,
  assessmentReviewInput,
  assessmentReviewOut,
  assessmentSubjects,
  type MailDecisionFamily,
} from "@cubby/schemas/assessment";
import { correctEmailRelevanceInput } from "@cubby/schemas/email-actions";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { mailboxClassification } from "@cubby/schemas/mailbox-research";
import { and, eq, like, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  getDb,
  notDeleted,
  withTransactionDatabase,
} from "~/server/db/helpers";
import {
  suggestionTable,
  email,
  emailClassificationObservation,
  emailPurchaseDecision,
  emailReview,
  purchase,
  runFinding,
  runOperation,
} from "~/server/db/schema";
import { emailLinkSubject } from "~/server/domains/email/repo/email-link-decision";
import {
  appendEmailReview,
  appendEmailReviewWithInsertion,
} from "~/server/domains/email/repo/email-review-store";
import type { EmailEvidenceWriteScope } from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import {
  appendEmailReviewFrontier,
  withEmailReviewBoundary,
} from "~/server/domains/purchase-import/repo/email-review-intent";
import type { PreparedEmailRelevanceCorrection } from "~/server/domains/purchase-import/repo/gmail/relevance-correction";
import {
  mailOutcomeByHandleSql,
  storedMailOutcome,
} from "~/server/domains/purchase-import/repo/mail-outcome/outcome";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";

type Review = z.infer<typeof assessmentReviewInput>;

/** One reviewable mail decision, whichever owner holds it. */
export type MailDecisionHandle = {
  family: MailDecisionFamily;
  id: string;
  subject: unknown;
  judgment: unknown;
  fingerprint: string | null;
  emailId: string | null;
  originalId: string | null;
  checksum: string | null;
};

const REVIEW_ACTIONS = {
  email_relevance: ["correct", "wrong", "uncertain"],
  email_link: ["correct", "wrong", "dismissed"],
  mail_import_outcome: ["correct", "wrong", "uncertain", "ungraded"],
} as const satisfies Record<MailDecisionFamily, readonly Review["verdict"][]>;

const observationHandle = (
  row: typeof emailClassificationObservation.$inferSelect,
): MailDecisionHandle => ({
  family: "email_relevance",
  id: row.id,
  subject: assessmentSubjects.email_relevance.parse({
    kind: "email_relevance",
    entity: "email",
    recordId: row.emailId,
    checksum: row.checksum,
    observationId: row.id,
  }),
  judgment: { classification: row.classification, stage: row.stage },
  fingerprint: row.checksum,
  emailId: row.emailId,
  originalId: null,
  checksum: row.checksum,
});

/**
 * Resolve a stored review handle to its owner. Carried decisions keep their old
 * Assessment id; a prediction's Assessment handle resolves through its subject.
 */
export async function resolveMailDecisionHandle(
  db: Database,
  id: string,
): Promise<MailDecisionHandle | null> {
  const client = getDb(db);
  const [decision] = await client
    .select()
    .from(emailPurchaseDecision)
    .where(eq(emailPurchaseDecision.id, id))
    .limit(1);
  if (decision)
    return {
      family: "email_link",
      id: decision.id,
      subject: emailLinkSubject(decision),
      judgment: { decision: decision.decision },
      fingerprint: decision.evidenceChecksum,
      emailId: decision.emailId,
      originalId: decision.originalId,
      checksum: decision.evidenceChecksum,
    };
  const [outcome] = await client
    .select({ runId: runOperation.runId, result: runOperation.result })
    .from(runOperation)
    .where(mailOutcomeByHandleSql(id))
    .limit(1);
  if (outcome) {
    const stored = z
      .object({
        mailOutcome: storedMailOutcome.shape.mailOutcome,
        target: z.object({ entityId: z.uuid() }),
      })
      .parse(outcome.result);
    return {
      family: "mail_import_outcome",
      id: stored.mailOutcome.id,
      subject: assessmentSubjects.mail_import_outcome.parse({
        kind: "mail_import_outcome",
        entity: "email",
        recordId: stored.target.entityId,
        checksum: stored.mailOutcome.checksum,
        runId: outcome.runId,
      }),
      judgment: stored.mailOutcome.judgment,
      fingerprint: stored.mailOutcome.fingerprint,
      emailId: stored.target.entityId,
      originalId: null,
      checksum: stored.mailOutcome.checksum,
    };
  }
  const [observation] = await client
    .select()
    .from(emailClassificationObservation)
    .where(eq(emailClassificationObservation.id, id))
    .limit(1);
  if (observation) return observationHandle(observation);
  const [finding] = await client
    .select({ id: runFinding.id })
    .from(runFinding)
    .where(eq(runFinding.id, id))
    .limit(1);
  // Problems findings are resolved by their own path.
  if (finding)
    throw new Error("run_finding Assessments are not reviewed as Suggestions");
  const [retained] = await client
    .select({ subject: suggestionTable.subject })
    .from(suggestionTable)
    .where(and(eq(suggestionTable.id, id), eq(suggestionTable.family, "email_relevance")))
    .limit(1);
  const predictionId = assessmentSubjects.email_relevance.safeParse(
    retained?.subject,
  ).data?.observationId;
  if (!predictionId) return null;
  const [prediction] = await client
    .select()
    .from(emailClassificationObservation)
    .where(eq(emailClassificationObservation.id, predictionId))
    .limit(1);
  return prediction ? observationHandle(prediction) : null;
}

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

function assertReviewable(handle: MailDecisionHandle, input: Review) {
  const { family } = handle;
  if (!REVIEW_ACTIONS[family].some((action) => action === input.verdict))
    throw new Error(`Unsupported ${family} review action ${input.verdict}`);
  if (input.suppression) {
    if (
      !["dismissed", "wrong"].includes(input.verdict) ||
      input.intent !== "history"
    )
      throw new Error(
        "Suppression requires history-only Dismissal or Wrong Feedback",
      );
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
  if (input.intent !== "history" && family === "mail_import_outcome")
    throw new Error("Mail import outcome grades are history only");
  if (input.intent === "draft")
    throw new Error("Only field Assessments support draft acceptance");
  if (input.intent === "apply" && family === "email_relevance")
    emailRelevanceApplication(
      assessmentSubjects.email_relevance.parse(handle.subject),
      input,
    );
  if (input.correction.present) {
    if (family === "mail_import_outcome")
      assessmentJudgments.mail_import_outcome.parse(input.correction.value);
    if (family === "email_link")
      assessmentJudgments.email_link.parse(input.correction.value);
    if (family === "email_relevance")
      mailboxClassification.parse(input.correction.value);
  }
}

/** The label a relevance review states, the correction or else its acceptance. */
function reviewedClassification(handle: MailDecisionHandle, input: Review) {
  if (handle.family !== "email_relevance") return null;
  const value = input.correction.present
    ? input.correction.value
    : input.verdict === "correct"
      ? assessmentJudgments.email_relevance.parse(handle.judgment)
          .classification
      : null;
  return mailboxClassification.safeParse(value).data ?? null;
}

const applicationOperation = (operationId: string) =>
  `command-application:${operationId}`;

async function applicationReceipt(
  db: Database,
  handle: MailDecisionHandle,
  operationId: string,
) {
  const [receipt] = await getDb(db)
    .select()
    .from(emailReview)
    .where(
      and(
        eq(emailReview.subjectId, handle.id),
        eq(emailReview.operationId, applicationOperation(operationId)),
      ),
    )
    .limit(1);
  return receipt;
}

type Outcome = z.infer<typeof assessmentReviewOut>;

/** Domain mutation, then its receipt, in the caller's one transaction. */
async function applyReview(
  db: Database,
  context: EntityKernelContext,
  handle: MailDecisionHandle,
  input: Review,
  command: typeof emailReview.$inferSelect,
  prepared: PreparedEmailRelevanceCorrection | null,
  scope: EmailEvidenceWriteScope | null,
): Promise<Outcome> {
  const outcome: Outcome = {
    assessmentId: handle.id,
    feedbackId: command.id,
    status: "applied",
    applied: true,
  };
  // Serialize commands without taking row locks ahead of the domain's parents.
  await getDb(db).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`assessment-review:${handle.id}`},0))`,
  );
  const prior = await applicationReceipt(db, handle, input.operationId);
  if (prior) {
    const receipt = z
      .object({ commandFeedbackId: z.uuid() })
      .safeParse(prior.metadata);
    if (receipt.data?.commandFeedbackId !== command.id)
      throw new Error("Invalid immutable application receipt for this command");
    return assessmentReviewOut.parse(prior.receipt);
  }
  if (handle.family === "email_link") {
    const [current] = await getDb(db)
      .select()
      .from(emailPurchaseDecision)
      .where(eq(emailPurchaseDecision.id, handle.id))
      .limit(1);
    if (!current?.active || current.status === "superseded")
      throw new Error(
        "Assessment evidence is stale; request a fresh assessment before applying",
      );
    if (current.status === "applied")
      throw new Error(
        "Assessment already resolved by another command; request a fresh assessment",
      );
    if (
      input.expectedFingerprint !== undefined &&
      input.expectedFingerprint !== current.evidenceChecksum
    )
      throw new Error("Assessment evidence fingerprint changed");
    const subject = assessmentSubjects.email_link.parse(handle.subject);
    if (!subject.recordId)
      throw new Error("Historical Email event has no current Email target");
    const [mail] = await getDb(db)
      .select({ code: email.shortcode })
      .from(email)
      .where(eq(email.id, parseEntityId("email", subject.recordId)))
      .limit(1);
    const decision = assessmentJudgments.email_link.parse(
      input.correction.present ? input.correction.value : handle.judgment,
    ).decision;
    const [target] = await getDb(db)
      .select({ code: purchase.shortcode })
      .from(purchase)
      .where(and(eq(purchase.id, current.purchaseId), notDeleted(purchase)))
      .limit(1);
    if (!mail || !target) throw new Error("Email link target no longer exists");
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
        expectedDecisionId: handle.id,
      },
    );
    await getDb(db)
      .update(emailPurchaseDecision)
      .set({ status: "applied" })
      .where(
        and(
          eq(emailPurchaseDecision.id, handle.id),
          eq(emailPurchaseDecision.active, true),
        ),
      );
  } else {
    const [resolved] = await getDb(db)
      .select({ id: emailReview.id })
      .from(emailReview)
      .where(
        and(
          eq(emailReview.subjectId, handle.id),
          like(emailReview.operationId, "command-application:%"),
        ),
      )
      .limit(1);
    if (resolved)
      throw new Error(
        "Assessment already resolved by another command; request a fresh assessment",
      );
    if (
      input.expectedFingerprint !== undefined &&
      input.expectedFingerprint !== handle.fingerprint
    )
      throw new Error("Assessment evidence fingerprint changed");
    if (!scope)
      throw new Error("Email application requires its outer write scope");
    if (!prepared || prepared.emailId !== handle.emailId)
      throw new Error("Email review requires its source-bound preparation");
    const { publishPreparedEmailRelevanceCorrection } =
      await import("~/server/domains/purchase-import/repo/gmail/relevance-correction");
    await publishPreparedEmailRelevanceCorrection(
      db,
      prepared,
      context.actorContext,
      scope,
    );
  }
  await appendEmailReview(db, {
    family: handle.family,
    subjectId: handle.id,
    emailId: null,
    originalId: null,
    checksum: null,
    operationId: applicationOperation(input.operationId),
    verdict: "ungraded",
    intent: "apply",
    authority: "member",
    actorUserId: context.actorContext.userId,
    subject: z.json().parse(handle.subject),
    receipt: outcome,
    metadata: { kind: "assessment_application", commandFeedbackId: command.id },
  });
  return outcome;
}

/** Command review is durable before this provider-preparation boundary. */
async function prepareAndApplyRelevance(
  db: Database,
  context: EntityKernelContext,
  handle: MailDecisionHandle,
  input: Review,
  execute: (
    prepared: PreparedEmailRelevanceCorrection | null,
  ) => Promise<Outcome>,
) {
  // A committed receipt replays before any external preparation.
  const hasReceipt = async () =>
    Boolean(await applicationReceipt(db, handle, input.operationId));
  if (await hasReceipt()) return execute(null);
  const subject = assessmentSubjects.email_relevance.parse(handle.subject);
  const correction = emailRelevanceApplication(subject, input);
  const [source] = await getDb(db)
    .select({ code: email.shortcode })
    .from(email)
    .where(eq(email.id, parseEntityId("email", subject.recordId)))
    .limit(1);
  if (!source) throw new Error("Email no longer exists");
  const {
    prepareEmailRelevanceCorrection,
    withEmailRelevancePreparation,
    EmailCorrectionCleanupError,
  } =
    await import("~/server/domains/purchase-import/repo/gmail/relevance-correction");
  let prepared: PreparedEmailRelevanceCorrection;
  try {
    prepared = await prepareEmailRelevanceCorrection(
      db,
      { id: parseShortcodeFor("email", source.code), ...correction },
      context.actorContext,
    );
  } catch (error) {
    // A committed receipt cannot conceal a failed cleanup from this invocation.
    if (error instanceof EmailCorrectionCleanupError) throw error;
    // Another invocation may have committed while this one's provider preparation failed.
    if (await hasReceipt()) return execute(null);
    throw error;
  }
  return withEmailRelevancePreparation(db, prepared, execute);
}

/**
 * `assessment.review` of a mail decision. History settles first: a stale or
 * refused application cannot erase the review.
 */
export async function settleMailDecisionReview(
  db: Database,
  context: EntityKernelContext,
  input: Review,
  handle: MailDecisionHandle,
  emailScope?: EmailEvidenceWriteScope,
): Promise<Outcome> {
  assertReviewable(handle, input);
  const writeReview = (transactionDb: Database) =>
    appendEmailReviewWithInsertion(transactionDb, {
      family: handle.family,
      subjectId: handle.id,
      emailId: handle.emailId,
      originalId: handle.originalId,
      checksum: handle.checksum,
      classification: reviewedClassification(handle, input),
      operationId: input.operationId,
      verdict: input.verdict,
      correction: input.correction,
      reason: input.reason,
      evidence: input.evidence,
      intent: input.intent,
      authority: "member",
      actorUserId: context.actorContext.userId,
      subject: z.json().parse(handle.subject),
      metadata: {
        kind: "assessment_review",
        application: null,
        expectedFingerprint: input.expectedFingerprint ?? null,
      },
    });
  const { event } = await withEmailReviewBoundary(
    db,
    handle,
    (scopedDb) =>
      withTransactionDatabase(scopedDb, async (transactionDb) => {
        const publication = await writeReview(transactionDb);
        // Historical retries cannot reconstruct the baseline of the original command.
        if (publication.inserted && handle.family !== "mail_import_outcome")
          await appendEmailReviewFrontier(
            transactionDb,
            {
              family: handle.family,
              subject: handle.subject,
              subjectId: handle.id,
            },
            publication.event.id,
          );
        return publication;
      }),
    emailScope,
  );
  if (input.intent === "apply") {
    const execute = (prepared: PreparedEmailRelevanceCorrection | null) =>
      withEmailReviewBoundary(
        db,
        handle,
        (scopedDb, scope) =>
          withTransactionDatabase(scopedDb, (transactionDb) =>
            applyReview(
              transactionDb,
              { ...context, db: transactionDb },
              handle,
              input,
              event,
              prepared,
              scope,
            ),
          ),
        emailScope,
      );
    return handle.family === "email_relevance"
      ? prepareAndApplyRelevance(db, context, handle, input, execute)
      : execute(null);
  }
  const status = await withEmailReviewBoundary(
    db,
    handle,
    (scopedDb) =>
      withTransactionDatabase(scopedDb, async (transactionDb) => {
        const next =
          input.verdict === "uncertain"
            ? null
            : input.verdict === "wrong"
              ? "rejected"
              : "resolved";
        if (handle.family !== "email_link") return next ?? "pending";
        const [current] = await getDb(transactionDb)
          .select({
            active: emailPurchaseDecision.active,
            status: emailPurchaseDecision.status,
          })
          .from(emailPurchaseDecision)
          .where(eq(emailPurchaseDecision.id, handle.id))
          .for("update")
          .limit(1);
        if (
          !next ||
          !current?.active ||
          ["applied", "superseded"].includes(current.status)
        )
          return current?.status ?? "historical";
        await getDb(transactionDb)
          .update(emailPurchaseDecision)
          .set({ status: next })
          .where(eq(emailPurchaseDecision.id, handle.id));
        return next;
      }),
    emailScope,
  );
  return {
    assessmentId: handle.id,
    feedbackId: event.id,
    status,
    applied: false,
  };
}
