import { mailboxClassification } from "@cubby/schemas/mailbox-research";
import { sql } from "drizzle-orm";

import { email } from "~/server/db/schema";
import {
  automatedStagesSql,
  emailLinkedSql,
  emailCompletedImportReadSql,
  emailHasCompletedImportSql,
  emailMemberClassificationSql,
} from "~/server/domains/email/repo/email-sql";

import { defineEntityChecks } from "../registry";

type Email = typeof email;

// Correlated subqueries name the unaliased "Email" root explicitly: Drizzle
// renders an interpolated column unqualified, which would bind to a same-named
// inner column. No entity rolls Email quality up under an alias.
const { related, uncertain, unrelated } = mailboxClassification.enum;
const retainedContent = sql`(
  "Email"."orderMailId" IS NOT NULL AND "Email"."contentClearedAt" IS NULL AND (
    EXISTS (
      SELECT 1 FROM "OrderMail" original
      WHERE original."id" = "Email"."orderMailId"
        AND COALESCE(
          NULLIF(BTRIM(original."content"->>'snippet'), ''),
          NULLIF(BTRIM(original."content"->>'bodyText'), ''),
          NULLIF(BTRIM(original."content"->>'bodyHtml'), '')
        ) IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM "OrderMailAttachment" attachment
      WHERE attachment."orderMailId" = "Email"."orderMailId"
        AND (attachment."pendingObjectKey" IS NOT NULL OR attachment."imageId" IS NOT NULL)
    )
  )
)`;

/** Settled automated negatives require no member review; their observations
 * remain available to independent accuracy sampling. */
export const emailChecks = defineEntityChecks({
  entity: "email",
  table: email,
  derivedRead: emailCompletedImportReadSql,
  filterRead: emailCompletedImportReadSql,
  checks: {
    email_relevance_undecided: {
      missing: (t: Email) => sql`${t.classification} = ${uncertain}`,
    },
    email_relevance_unreviewed: {
      expected: (t: Email) =>
        sql`${t.classification} <> ${unrelated} AND ${t.classificationStage} IN ${automatedStagesSql}`,
      missing: () => sql`(${emailMemberClassificationSql()}) IS NULL`,
    },
    email_original_missing: {
      expected: (t: Email) =>
        sql`${t.classification} IN (${related}, ${uncertain})`,
      missing: () => sql`NOT ${retainedContent}`,
    },
    email_preview_missing: {
      expected: (t: Email) =>
        sql`${t.classification} = ${related} AND NOT ${emailLinkedSql()}`,
      missing: () => sql`NOT EXISTS (
        SELECT 1 FROM "EmailCandidateObservation" preview
        WHERE preview."emailId" = "Email"."id"
          AND preview."preview"->>'checksum' = "Email"."checksum"
      )`,
    },
    email_not_imported: {
      expected: (t: Email) => sql`${t.classification} = ${related}`,
      missing: (_t: Email, context) =>
        sql`NOT ${emailLinkedSql()} AND NOT ${
          context
            ? sql`${sql.identifier(context.derivedAlias)}."completedImport"`
            : emailHasCompletedImportSql()
        }`,
    },
  },
});
