import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { eq, getTableColumns, sql, Subquery } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { email, orderMail } from "~/server/db/schema";
import { emailLinkedSql } from "~/server/domains/email/repo/email-sql";
import { entityDisplayImagePresenceSql } from "~/server/entity-kernel/repo/entity-display-image";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

/** Bump when the rules or their declared scoring metadata change. */
export const EMAIL_QUALITY_RULES_VERSION = 2;

type EmailQualityRecord = Awaited<
  ReturnType<typeof loadEmailQualityRecords>
>[number];
const observed = qualityCheck.observed<EmailQualityRecord>;
const when = qualityCheck.when<EmailQualityRecord>;

/** Automated decisions are final; an import outcome resolves relevance, so
 * linked or imported mail is never undecided and no member review is owed. */
export const emailChecks = defineStoredEntityChecks({
  entity: "email",
  table: email,
  rulesVersion: EMAIL_QUALITY_RULES_VERSION,
  load: loadEmailQualityRecords,
  checks: {
    email_relevance_undecided: when(
      (r) => !r.linked && !r.completedImport,
      observed((r) => r.classification !== "uncertain"),
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
  // Extract each completed Run's source keys once, preserving explicit JSON
  // null while excluding absent keys and scalar sources. Membership is scoped
  // to the same member; COALESCE keeps unknown tuple comparisons false.
  const scopedEmails = new Subquery(
    sql`
    WITH completed_mail_imports AS MATERIALIZED (
      SELECT DISTINCT import."ledgerPartyId", source.value->'orderMailId' AS "orderMailId"
      FROM "Run" import
      CROSS JOIN LATERAL jsonb_array_elements(CASE
        WHEN jsonb_typeof(import.input->'sources') = 'array' THEN import.input->'sources'
        ELSE '[]'::jsonb END) source(value)
      WHERE import.purpose = ${runPurpose.enum.mail_import}
        AND import.status = ${runStatus.enum.completed}
        AND ${notDeleted("import")}
        AND source.value->'orderMailId' IS NOT NULL
    )
    SELECT original.*, coalesce(
      (original."ledgerPartyId", coalesce(to_jsonb(original."orderMailId"::text), 'null'::jsonb))
        IN (SELECT "ledgerPartyId", "orderMailId" FROM completed_mail_imports),
      false
    ) AS "completedImport"
    FROM "Email" original
    WHERE ${notDeleted("original")} AND original.id = ANY(${uuidArrayParam(ids)})
  `,
    getTableColumns(email),
    "Email",
  );
  // Domain evidence is resolved only for this ID page. No retained body is read.
  return unwrapDb(db)
    .select({
      id: email.id,
      shortcode: email.shortcode,
      classification: email.classification,
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
      linked: emailLinkedSql(),
      completedImport: sql<boolean>`"Email"."completedImport"`,
      hasDisplayImage: sql<boolean>`${entityDisplayImagePresenceSql("email", sql`${email.id}`)}`,
    })
    .from(scopedEmails)
    .leftJoin(orderMail, eq(orderMail.id, email.orderMailId));
}
