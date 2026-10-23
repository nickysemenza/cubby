import { mailboxClassificationStage } from "@cubby/schemas/mailbox-research";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { and, eq, sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { email, orderMail } from "~/server/db/schema";
import {
  emailLinkedSql,
  emailMemberClassificationSql,
} from "~/server/domains/email/repo/email-sql";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
export const EMAIL_QUALITY_RULES_VERSION = 1;

type EmailQualityRecord = Awaited<
  ReturnType<typeof loadEmailQualityRecords>
>[number];
const observed = qualityCheck.observed<EmailQualityRecord>;
const when = qualityCheck.when<EmailQualityRecord>;
const { rule, decision, model } = mailboxClassificationStage.enum;

/** Settled automated negatives require no member review. */
export const emailChecks = defineStoredEntityChecks({
  entity: "email",
  table: email,
  rulesVersion: EMAIL_QUALITY_RULES_VERSION,
  load: loadEmailQualityRecords,
  checks: {
    email_relevance_undecided: observed(
      (r) => r.classification !== "uncertain",
    ),
    email_relevance_unreviewed: when(
      (r) =>
        r.classification !== null &&
        r.classification !== "unrelated" &&
        (r.classificationStage === rule ||
          r.classificationStage === decision ||
          r.classificationStage === model),
      observed((r) => r.memberClassification !== null),
    ),
    email_original_missing: when(
      (r) => r.classification === "related" || r.classification === "uncertain",
      observed(
        (r) =>
          r.orderMailId !== null &&
          r.contentClearedAt === null &&
          (r.hasRetainedText === true || r.hasRetainedAttachment),
      ),
    ),
    email_preview_missing: when(
      (r) => r.classification === "related" && !r.linked,
      observed((r) => r.hasCurrentPreview),
    ),
    email_not_imported: when(
      (r) => r.classification === "related",
      observed((r) => r.linked || r.completedImport),
    ),
    email_display_image: observed((r) => r.hasDisplayImage),
  },
});

async function loadEmailQualityRecords(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
) {
  if (!ids.length) return [];
  // Domain evidence is resolved only for this ID page, once per record and
  // shared by its checks. No retained body is selected or decompressed.
  return unwrapDb(db)
    .select({
      id: email.id,
      shortcode: email.shortcode,
      classification: email.classification,
      classificationStage: email.classificationStage,
      orderMailId: email.orderMailId,
      contentClearedAt: email.contentClearedAt,
      hasRetainedText: orderMail.hasRetainedText,
      hasRetainedAttachment: sql<boolean>`EXISTS (
      SELECT 1 FROM "OrderMailAttachment" attachment
      WHERE attachment."orderMailId" = "Email"."orderMailId"
        AND (attachment."pendingObjectKey" IS NOT NULL OR attachment."imageId" IS NOT NULL)
    )`,
      hasCurrentPreview: sql<boolean>`EXISTS (
      SELECT 1 FROM "EmailCandidateObservation" preview
      WHERE preview."emailId" = "Email"."id"
        AND preview.preview->>'checksum' = "Email"."checksum"
    )`,
      memberClassification: emailMemberClassificationSql(),
      linked: emailLinkedSql(),
      // Preserve JSON containment, including explicit null, missing-key/scalar
      // exclusion and completed, live, same-member Mail import ownership.
      completedImport: sql<boolean>`EXISTS (
      SELECT 1 FROM "Run" import
      WHERE import.purpose = ${runPurpose.enum.mail_import}
        AND import.status = ${runStatus.enum.completed}
        AND import."deletedAt" IS NULL
        AND import."ledgerPartyId" = "Email"."ledgerPartyId"
        AND import.input @> jsonb_build_object('sources', jsonb_build_array(
          jsonb_build_object('orderMailId', "Email"."orderMailId"::text)
        ))
    )`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("email", sql`${email.id}`)}`,
    })
    .from(email)
    .leftJoin(orderMail, eq(orderMail.id, email.orderMailId))
    .where(
      and(notDeleted(email), sql`${email.id} = ANY(${uuidArrayParam(ids)})`),
    );
}
