import {
  emailProtectingIntentFrontier,
  type EmailProtectingIntentFrontier,
} from "@cubby/schemas/email-observations";
import { connectionCandidate } from "@cubby/schemas/entity-connections";
import { emailId } from "@cubby/schemas/identifiers";
import {
  suggestionFamily,
  suggestionProducer,
  suggestionSubjects,
} from "@cubby/schemas/suggestion";
import { correctionAuthorityReceiptKinds } from "@cubby/schemas/suggestion-correction";
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db/database";
import { notDeleted } from "~/server/db/helpers/predicates";
import { textArrayParam } from "~/server/db/helpers/query";
import { decision } from "~/server/db/kernel-schema";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import {
  email,
  connectionCandidateEvidence,
} from "~/server/db/retained-tables";
import { emailReviewsRead } from "~/server/domains/email/repo/email-decision-sql";
import {
  assertEmailEvidenceScope,
  withEmailEvidenceWrite,
  type EmailEvidenceWriteScope,
} from "~/server/domains/purchase-import/repo/email-evidence-write-scope";

type ReviewSubject = {
  family: z.infer<typeof suggestionFamily>;
  subject: unknown;
};

const relevantReview = (input: ReviewSubject) => {
  if (input.family === "email_relevance" || input.family === "email_link")
    return true;
  return false;
};

function emailIntentSubjectSql(id: SQL, originalId: SQL) {
  return and(
    inArray(emailReviewsRead.family, [
      suggestionFamily.enum.email_relevance,
      suggestionFamily.enum.email_link,
    ]),
    or(
      eq(emailReviewsRead.emailId, id),
      and(
        eq(emailReviewsRead.family, suggestionFamily.enum.email_link),
        isNull(emailReviewsRead.emailId),
        eq(emailReviewsRead.originalId, originalId),
      ),
    ),
  );
}

/** Same retained-subject boundary used by admission before bounded pagination. */
export function emailHasProtectingIntentSql(id: SQL, originalId: SQL) {
  const subject = emailIntentSubjectSql(id, originalId);
  const kind = sql`${emailReviewsRead.metadata}->>${suggestionProducer.keyof().enum.kind}`;
  return sql`(EXISTS (SELECT 1 FROM ${emailReviewsRead}
    WHERE ${subject} AND ((${emailReviewsRead.authority} = ${"member"}
      AND (${kind} IS NULL OR NOT (${kind} = ANY(${textArrayParam(correctionAuthorityReceiptKinds.options)}))))
      OR ${kind} IN (${"email_resolution"}, ${"email_link"}))) OR EXISTS (
      SELECT 1 FROM ${decision} d JOIN ${connectionCandidateEvidence} e ON d.subject='connection/' || e."scopeKey"
      WHERE d.channel=${"assignment"} AND d.field=${"link"} AND d.kind=${"set"} AND d."actorKind"=${"member"}
        AND ((e."sourceEntity"=${"email"} AND e."sourceId"=${id}) OR (e."targetEntity"=${"email"} AND e."targetId"=${id}))))`;
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
      id: emailReviewsRead.id,
      authority: emailReviewsRead.authority,
      kind: sql<
        string | null
      >`${emailReviewsRead.metadata}->>${suggestionProducer.keyof().enum.kind}`,
      family: emailReviewsRead.family,
      subject: emailReviewsRead.subject,
    })
    .from(emailReviewsRead)
    .where(emailIntentSubjectSql(sql`${id}`, sql`${mail.originalId}`))
    .orderBy(asc(emailReviewsRead.id));
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
    if (!suggestionSubjects[row.family].safeParse(row.subject).success)
      return {
        status: "held",
        emailId: id,
        reason: "Retained Email intent has an invalid subject",
      };
    feedbackIds.push(row.id);
  }
  const connections = await getDb(db)
    .select({
      id: decision.id,
      candidate: connectionCandidateEvidence.candidate,
    })
    .from(decision)
    .innerJoin(
      connectionCandidateEvidence,
      sql`${decision.subject}='connection/' || ${connectionCandidateEvidence.scopeKey}`,
    )
    .where(
      and(
        eq(decision.actorKind, "member"),
        eq(decision.channel, "assignment"),
        eq(decision.field, "link"),
        eq(decision.kind, "set"),
        or(
          and(
            eq(connectionCandidateEvidence.sourceEntity, "email"),
            eq(connectionCandidateEvidence.sourceId, id),
          ),
          and(
            eq(connectionCandidateEvidence.targetEntity, "email"),
            eq(connectionCandidateEvidence.targetId, id),
          ),
        ),
      ),
    );
  for (const row of connections) {
    const candidate = connectionCandidate.safeParse(row.candidate);
    if (
      !candidate.success ||
      candidate.data.source.entityKind !== "email" ||
      candidate.data.source.entityId !== mail.code ||
      candidate.data.target.entityKind !== "purchase"
    )
      return {
        status: "held",
        emailId: id,
        reason:
          "Retained Email connection intent has incomplete endpoint proof",
      };
    feedbackIds.push(row.id);
  }
  return emailProtectingIntentFrontier.parse({
    status: "captured",
    emailId: id,
    feedbackIds,
  });
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
