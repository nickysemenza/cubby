import { mailboxClassification } from "@cubby/schemas/mailbox-research";
import { runPurpose, runStatus } from "@cubby/schemas/run-fields";
import { sql } from "drizzle-orm";

import { email } from "~/server/db/schema";
import {
  automatedStagesSql,
  emailLinkedSql,
  emailMemberClassificationSql,
} from "~/server/repo/email-sql";

import { defineEntityChecks } from "../registry";

type Email = typeof email;

// Correlated subqueries name the unaliased "Email" root explicitly: Drizzle
// renders an interpolated column unqualified, which would bind to a same-named
// inner column. No entity rolls Email quality up under an alias.
const { related, uncertain } = mailboxClassification.enum;
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

/** Relevance-conditional pipeline gaps: an unrelated Email can only lack review. */
export const emailChecks = defineEntityChecks({
  entity: "email",
  table: email,
  checks: {
    email_relevance_undecided: {
      missing: (t: Email) => sql`${t.classification} = ${uncertain}`,
    },
    email_relevance_unreviewed: {
      expected: (t: Email) =>
        sql`${t.classificationStage} IN ${automatedStagesSql}`,
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
      missing: () => sql`NOT ${emailLinkedSql()} AND NOT EXISTS (
        SELECT 1 FROM "Run" import
        WHERE import."purpose" = ${runPurpose.enum.mail_import}
          AND import."status" = ${runStatus.enum.completed}
          AND import."deletedAt" IS NULL
          AND import."ledgerPartyId" = "Email"."ledgerPartyId"
          AND import."input" @> jsonb_build_object(
            'sources', jsonb_build_array(jsonb_build_object('orderMailId', "Email"."orderMailId"::text))
          )
      )`,
    },
  },
});
