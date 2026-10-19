import { mailboxClassification } from "@cubby/schemas/mailbox-research";
import { sql } from "drizzle-orm";

import { email } from "~/server/db/retained-tables";
import {
  automatedStagesSql,
  emailLinkedSql,
  emailQualityReadSql,
  emailQualityFilterReadSql,
  emailHasCompletedImportSql,
  emailMemberClassificationSql,
  emailRetainedContentSql,
} from "~/server/domains/email/repo/email-sql";

import {
  defineEntityChecks,
  qualityReadColumn,
  type QualityReadContext,
} from "../registry";

type Email = typeof email;

// Correlated subqueries name the unaliased "Email" root explicitly: Drizzle
// renders an interpolated column unqualified, which would bind to a same-named
// inner column. No entity rolls Email quality up under an alias.
const { related, uncertain, unrelated } = mailboxClassification.enum;

const linked = (context?: QualityReadContext) =>
  qualityReadColumn(context, "linked") ?? emailLinkedSql();

/** Settled automated negatives require no member review; their observations
 * remain available to independent accuracy sampling. */
export const emailChecks = defineEntityChecks({
  entity: "email",
  table: email,
  derivedRead: emailQualityReadSql,
  filterRead: emailQualityFilterReadSql,
  checks: {
    email_relevance_undecided: {
      missing: (t: Email) => sql`${t.classification} = ${uncertain}`,
    },
    email_relevance_unreviewed: {
      expected: (t: Email) =>
        sql`${t.classification} <> ${unrelated} AND ${t.classificationStage} IN ${automatedStagesSql}`,
      missing: (_t: Email, context) =>
        sql`(${
          qualityReadColumn(context, "memberClassification") ??
          emailMemberClassificationSql()
        }) IS NULL`,
    },
    email_original_missing: {
      expected: (t: Email) =>
        sql`${t.classification} IN (${related}, ${uncertain})`,
      missing: (_t: Email, context) =>
        sql`NOT ${
          qualityReadColumn(context, "retainedContent") ??
          emailRetainedContentSql()
        }`,
    },
    email_preview_missing: {
      expected: (t: Email, context) =>
        sql`${t.classification} = ${related} AND NOT ${linked(context)}`,
      missing: () => sql`NOT EXISTS (
        SELECT 1 FROM "EmailCandidateObservation" preview
        WHERE preview."emailId" = "Email"."id"
          AND preview."preview"->>'checksum' = "Email"."checksum"
      )`,
    },
    email_not_imported: {
      expected: (t: Email) => sql`${t.classification} = ${related}`,
      missing: (_t: Email, context) =>
        sql`NOT ${linked(context)} AND NOT ${
          qualityReadColumn(context, "completedImport") ??
          emailHasCompletedImportSql()
        }`,
    },
  },
});
