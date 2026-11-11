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
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { email, emailReview } from "~/server/db/retained-tables";
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
  const subject = suggestionSubjects.recommendation.safeParse(input.subject);
  return (
    input.family === "recommendation" &&
    subject.success &&
    subject.data.entity === "email" &&
    subject.data.scope === "connection.email-purchase"
  );
};

function emailIntentSubjectSql(id: SQL, originalId: SQL) {
  return and(
    inArray(emailReview.family, [
      suggestionFamily.enum.email_relevance,
      suggestionFamily.enum.email_link,
      suggestionFamily.enum.recommendation,
    ]),
    or(
      eq(emailReview.emailId, id),
      and(
        eq(emailReview.family, suggestionFamily.enum.email_link),
        isNull(emailReview.emailId),
        eq(emailReview.originalId, originalId),
      ),
    ),
  );
}

/** Same retained-subject boundary used by admission before bounded pagination. */
export function emailHasProtectingIntentSql(id: SQL, originalId: SQL) {
  const subject = emailIntentSubjectSql(id, originalId);
  const kind = sql`${emailReview.metadata}->>${suggestionProducer.keyof().enum.kind}`;
  return sql`EXISTS (SELECT 1 FROM ${emailReview}
    WHERE ${subject} AND ((${emailReview.authority} = ${"member"}
      AND (${kind} IS NULL OR NOT (${kind} = ANY(${textArrayParam(correctionAuthorityReceiptKinds.options)}))))
      OR ${kind} IN (${"email_resolution"}, ${"email_link"})))`;
}

/** The endpoints a connection review stored from its Suggestion's evidence. */
const reviewedConnection = z.object({
  candidate: z
    .object({
      relation: z.unknown(),
      source: z.unknown(),
      target: z.unknown(),
    })
    .nullish(),
});

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
      id: emailReview.id,
      authority: emailReview.authority,
      kind: sql<
        string | null
      >`${emailReview.metadata}->>${suggestionProducer.keyof().enum.kind}`,
      family: emailReview.family,
      subject: emailReview.subject,
    })
    .from(emailReview)
    .where(emailIntentSubjectSql(sql`${id}`, sql`${mail.originalId}`))
    .orderBy(asc(emailReview.id));
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
      const candidate = reviewedConnection.safeParse(row.subject).data
        ?.candidate;
      const relation = connectionCandidate.shape.relation.safeParse(
        candidate?.relation,
      );
      const source = connectionCandidate.shape.source.safeParse(
        candidate?.source,
      );
      const target = connectionCandidate.shape.target.safeParse(
        candidate?.target,
      );
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
    } else if (!suggestionSubjects[row.family].safeParse(row.subject).success) {
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
