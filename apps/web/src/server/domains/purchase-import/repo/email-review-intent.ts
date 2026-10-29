import {
  assessmentFamily,
  assessmentSubjects,
  assessmentProducer,
} from "@cubby/schemas/assessment";
import {
  emailProtectingIntentFrontier,
  emailReviewFrontierReceipt,
  type EmailProtectingIntentFrontier,
} from "@cubby/schemas/email-observations";
import { connectionCandidate } from "@cubby/schemas/entity-connections";
import { emailId } from "@cubby/schemas/identifiers";
import { correctionAuthorityReceiptKinds } from "@cubby/schemas/suggestion-correction";
import { and, asc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase as withTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { assessment, email, feedback } from "~/server/db/retained-tables";
import {
  assertEmailEvidenceScope,
  withEmailEvidenceWrite,
  type EmailEvidenceWriteScope,
} from "~/server/domains/purchase-import/repo/email-evidence-write-scope";
import {
  recordFeedback,
  type recordFeedbackWithInsertion,
} from "~/server/generic/assessment/repo/assessment";

type ReviewSubject = Pick<typeof assessment.$inferSelect, "family" | "subject">;

const relevantReview = (input: ReviewSubject) => {
  if (input.family === "email_relevance" || input.family === "email_link")
    return true;
  const subject = assessmentSubjects.recommendation.safeParse(input.subject);
  return (
    input.family === "recommendation" &&
    subject.success &&
    subject.data.entity === "email" &&
    subject.data.scope === "connection.email-purchase"
  );
};

function emailIntentSubjectSql(id: SQL, originalId: SQL) {
  return or(
    and(
      inArray(assessment.family, [
        assessmentFamily.enum.email_relevance,
        assessmentFamily.enum.email_link,
      ]),
      or(
        sql`${assessment.subject}->>'recordId' = ${id}::text`,
        and(
          eq(assessment.family, assessmentFamily.enum.email_link),
          sql`${assessment.subject}->>'recordId' IS NULL`,
          sql`${assessment.subject}->>'originalId' = ${originalId}::text`,
        ),
      ),
    ),
    and(
      eq(assessment.family, assessmentFamily.enum.recommendation),
      sql`${assessment.subject}->>'scope' = ${"connection.email-purchase"}`,
      sql`${assessment.subject}->>'entity' = ${"email"}`,
      sql`${assessment.subject}->>'recordId' = ${id}::text`,
    ),
  );
}

/** Same retained-subject boundary used by admission before bounded pagination. */
export function emailHasProtectingIntentSql(id: SQL, originalId: SQL) {
  const subject = emailIntentSubjectSql(id, originalId);
  const kind = sql`${feedback.metadata}->>${assessmentProducer.keyof().enum.kind}`;
  return sql`EXISTS (SELECT 1 FROM ${feedback} JOIN ${assessment} ON ${assessment.id} = ${feedback.assessmentId}
    WHERE ${subject} AND ((${feedback.authority} = ${"member"}
      AND (${kind} IS NULL OR ${kind} NOT IN (${sql.join(
        correctionAuthorityReceiptKinds.options.map((value) => sql`${value}`),
        sql`, `,
      )})))
      OR ${kind} IN (${"email_resolution"}, ${"email_link"})))`;
}

/** Retained subjects and all checksums matter; active projections are not an intent history. */
export async function readEmailProtectingIntent(
  db: Database,
  id: z.infer<typeof emailId>,
): Promise<EmailProtectingIntentFrontier> {
  const [mail] = await getDb(db)
    .select({
      code: email.shortcode,
      originalId: email.orderMailId,
    })
    .from(email)
    .where(and(eq(email.id, id), notDeleted(email)))
    .limit(1);
  if (!mail)
    return {
      status: "held",
      emailId: id,
      reason: "Email intent subject is no longer live",
    };
  const rows = await getDb(db)
    .select({
      id: feedback.id,
      authority: feedback.authority,
      kind: sql<
        string | null
      >`${feedback.metadata}->>${assessmentProducer.keyof().enum.kind}`,
      family: assessment.family,
      subject: assessment.subject,
      relation: sql<unknown>`${assessment.evidence}->'candidate'->${connectionCandidate.keyof().enum.relation}`,
      source: sql<unknown>`${assessment.evidence}->'candidate'->${connectionCandidate.keyof().enum.source}`,
      target: sql<unknown>`${assessment.evidence}->'candidate'->${connectionCandidate.keyof().enum.target}`,
    })
    .from(feedback)
    .innerJoin(assessment, eq(assessment.id, feedback.assessmentId))
    .where(emailIntentSubjectSql(sql`${id}`, sql`${mail.originalId}`))
    .orderBy(asc(feedback.id));
  const feedbackIds: string[] = [];
  for (const row of rows) {
    const command =
      row.authority === "member" &&
      !correctionAuthorityReceiptKinds.options.some(
        (kind) => kind === row.kind,
      );
    const domainDecision =
      row.kind === "email_resolution" || row.kind === "email_link";
    if (!command && !domainDecision) continue;
    if (row.family === "recommendation") {
      const relation = connectionCandidate.shape.relation.safeParse(
        row.relation,
      );
      const source = connectionCandidate.shape.source.safeParse(row.source);
      const target = connectionCandidate.shape.target.safeParse(row.target);
      if (
        !relation.success ||
        relation.data !== "email-purchase" ||
        !source.success ||
        source.data.entityKind !== "email" ||
        !target.success ||
        target.data.entityKind !== "purchase" ||
        source.data.entityId !== mail.code
      )
        return {
          status: "held",
          emailId: id,
          reason:
            "Retained Email connection intent has incomplete endpoint proof",
        };
    } else if (!assessmentSubjects[row.family].safeParse(row.subject).success) {
      return {
        status: "held",
        emailId: id,
        reason: "Retained Email intent has an invalid subject",
      };
    }
    feedbackIds.push(row.id);
  }
  return emailProtectingIntentFrontier.parse({
    status: "captured",
    emailId: id,
    feedbackIds,
  });
}

async function reviewFrontier(
  db: Database,
  input: ReviewSubject,
): Promise<EmailProtectingIntentFrontier> {
  if (input.family === "email_relevance") {
    const subject = assessmentSubjects.email_relevance.safeParse(input.subject);
    if (subject.success)
      return readEmailProtectingIntent(
        db,
        emailId.parse(subject.data.recordId),
      );
  } else if (input.family === "recommendation") {
    const subject = assessmentSubjects.recommendation.safeParse(input.subject);
    if (subject.success)
      return readEmailProtectingIntent(
        db,
        emailId.parse(subject.data.recordId),
      );
  } else if (input.family === "email_link") {
    const subject = assessmentSubjects.email_link.safeParse(input.subject);
    if (subject.success) {
      if (subject.data.recordId)
        return readEmailProtectingIntent(
          db,
          emailId.parse(subject.data.recordId),
        );
      const matches = await getDb(db)
        .select({ id: email.id })
        .from(email)
        .where(
          and(
            eq(email.orderMailId, subject.data.originalId),
            notDeleted(email),
          ),
        )
        .limit(2);
      if (matches.length === 1 && matches[0])
        return readEmailProtectingIntent(db, emailId.parse(matches[0].id));
    }
  }
  return {
    status: "held",
    emailId: null,
    reason: "Retained review does not prove one current Email identity",
  };
}

/** Select only Email review writes; other families retain their own transaction owner. */
export async function withEmailReviewBoundary<T>(
  db: Database,
  input: ReviewSubject,
  action: (
    transactionDb: Database,
    scope: EmailEvidenceWriteScope | null,
  ) => Promise<T>,
  scope?: EmailEvidenceWriteScope,
): Promise<T> {
  if (!relevantReview(input)) return action(db, null);
  if (scope !== undefined) {
    assertEmailEvidenceScope(db, scope);
    return action(db, scope);
  }
  return withEmailEvidenceWrite(db, action);
}

/** Atomic command/frontier association only; complete effect ownership and outer fences remain required. */
export async function withEmailReviewFrontier(
  db: Database,
  input: ReviewSubject,
  action: (
    transactionDb: Database,
  ) => ReturnType<typeof recordFeedbackWithInsertion>,
  scope?: EmailEvidenceWriteScope,
) {
  if (!relevantReview(input)) return action(db);
  return withEmailReviewBoundary(
    db,
    input,
    (scopedDb) =>
      withTransactionDatabase(scopedDb, async (transactionDb) => {
        const publication = await action(transactionDb);
        const command = publication.event;
        // Historical retries cannot reconstruct the baseline of the original command.
        if (!publication.inserted || command.authority !== "member")
          return publication;
        const capture = emailReviewFrontierReceipt.parse({
          version: "email-review-frontier-v1",
          commandFeedbackId: command.id,
          frontier: await reviewFrontier(transactionDb, input),
        });
        await recordFeedback(transactionDb, {
          assessmentId: command.assessmentId,
          operationId: `email-review-frontier:${command.id}`,
          verdict: "ungraded",
          authority: "system",
          actorUserId: null,
          intent: "history",
          receipt: capture,
          metadata: {
            kind: "email_review_frontier",
            commandFeedbackId: command.id,
          },
        });
        return publication;
      }),
    scope,
  );
}
