import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
  feedbackAuthority,
  feedbackVerdict,
} from "@cubby/schemas/assessment";
import { entitySchema } from "@cubby/schemas/entity";
import {
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import { and, getTableName, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { getDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { outer } from "~/server/db/helpers/related";
import { entityIdentity, assessmentState } from "~/server/db/schema";
import { workExpenseSourceOwners } from "~/server/domains/expense/repo/work-owners";
import { financialTransactionWorkOwners } from "~/server/domains/financial-transaction/repo/work-facts";
import {
  workImageOwners,
  workImageIsShared,
} from "~/server/domains/image/repo/work-owners";
import { workPurchaseSourceOwners } from "~/server/domains/purchase/repo/work-owners";
import { workRunReviewOwners } from "~/server/domains/run/repo/work-owners";
import {
  pendingSuggestion,
  pendingStatementStateSql,
  suggestionField,
} from "~/server/domains/transaction-import/repo/statement-charge";
import { workRecordFactsFor } from "~/server/domains/work/repo/record-facts";
import {
  pendingImageDescriptionEligibility,
  reviewFamilyDeclarations,
} from "~/server/generic/assessment/repo/review-families";
import { reviewableSuggestionSql } from "~/server/generic/assessment/repo/suggestion-review";
import { labelSql } from "~/server/generic/entity-graph/repo/entity-graph";
import { SHORTCODE_TABLE } from "~/server/generic/shortcode/repo/shortcode-tables";
import { recordScope } from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

const recordAuthority = (entity: ShortcodeEntity, id: SQL) => {
  switch (entity) {
    case "purchase":
      return { owners: workPurchaseSourceOwners(id), shared: false };
    case "expense":
      return { owners: workExpenseSourceOwners(id), shared: false };
    case "image":
      return { owners: workImageOwners(id), shared: workImageIsShared(id) };
    case "run":
      return { owners: workRunReviewOwners(id), shared: false };
    case "financialTransaction":
      return { owners: financialTransactionWorkOwners(id), shared: false };
    case "financialAccount":
      return {
        owners: sql`ARRAY["FinancialAccount"."ledgerPartyId"]`,
        shared: false,
      };
    case "vendorAccount":
      return {
        owners: sql`ARRAY["VendorAccount"."ledgerPartyId"]`,
        shared: false,
      };
    case "email":
      return { owners: sql`ARRAY["Email"."ledgerPartyId"]`, shared: false };
    default:
      return { owners: sql`ARRAY[]::uuid[]`, shared: true };
  }
};

const source: WorkSource = {
  id: "pending-suggestions",
  family: "suggestion",
  executor: "human",
  entity: null,
  // Several proposal families can touch one record; open all its suggestions.
  link: { kind: "suggestions", family: "all" },
  reasons: [
    "field",
    "image_description",
    "recommendation",
    "statement_transaction",
    "transfer_pair",
  ].map((family) => ({
    key: `suggestions:${family}`,
    label: "Pending suggestions",
  })),
  candidates: async (db, scope) => {
    const target = (field: "entityId" | "entityKind") =>
      sql`prediction.target->>${field}`;
    const connectionWhere = sql`current.family = ${assessmentFamily.enum.recommendation} AND current.active AND current.status = ${suggestionStatus.enum.pending}
      AND prediction.subject->>'scope' LIKE 'connection.%'
      AND ${notDeleted(alias(entityIdentity, "root"))} AND root."mergedIntoId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Feedback" reviewed WHERE reviewed."assessmentId" = prediction.id
        AND reviewed.authority = ${feedbackAuthority.enum.member} AND reviewed.verdict IN (${feedbackVerdict.enum.wrong}, ${feedbackVerdict.enum.dismissed}))
      AND NOT EXISTS (SELECT 1 FROM "AssessmentState" hidden WHERE hidden.active AND hidden.entity = current.entity
        AND hidden."recordId" = current."recordId" AND hidden.suppression->>'scope' = prediction.subject->>'scope'
        AND hidden.suppression->>'candidateKey' = prediction.subject->>'candidateKey'
        AND (hidden.suppression->>'fingerprint' IS NULL OR hidden.suppression->>'fingerprint' = prediction.fingerprint))
      AND ${notDeleted(alias(entityIdentity, "other"))} AND other."mergedIntoId" IS NULL`;
    const connectionFrom = sql`"AssessmentState" current
      JOIN work_connection_prediction prediction ON prediction.id = current.id
      JOIN "Entity" root ON root.id = current."recordId" AND root.kind = current.entity
      JOIN "Entity" other ON other.shortcode = ${target("entityId")} AND other.kind = ${target("entityKind")}`;
    const field = getDb(db)
      .select({
        entity: assessmentState.entity,
        record_id: sql`${assessmentState.recordId}::text`.as("record_id"),
        reason_key: sql`${"suggestions:field"}::text`.as("reason_key"),
      })
      .from(assessmentState)
      .where(
        and(
          assessmentState.active,
          sql`${assessmentState.status} = ${suggestionStatus.enum.pending}`,
          sql`${assessmentState.family} = ${assessmentFamily.enum.field}`,
          reviewableSuggestionSql,
        ),
      );
    const pending = sql`${field}
      UNION ALL SELECT s.entity, s."recordId"::text, ${"suggestions:image_description"}::text FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id WHERE ${pendingImageDescriptionEligibility()}
      UNION ALL SELECT root.kind, root.id::text, ${"suggestions:recommendation"}::text FROM ${connectionFrom} WHERE ${connectionWhere}
      UNION ALL SELECT other.kind, other.id::text, ${"suggestions:recommendation"}::text FROM ${connectionFrom} WHERE ${connectionWhere}
      UNION ALL SELECT ${entitySchema.enum.financialAccount}::text, ${suggestionField("accountId")}, ${"suggestions:statement_transaction"}::text FROM work_statement_state s WHERE ${pendingSuggestion("s", { populationRead: true })}
      UNION ALL SELECT refs.value->>'entity', refs.value->>'id', ${"suggestions:transfer_pair"}::text FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id
        CROSS JOIN LATERAL jsonb_array_elements(${reviewFamilyDeclarations.transfer_pair.records}) refs(value)
        WHERE s.family = ${assessmentFamily.enum.transfer_pair} AND s.active AND s.status = ${suggestionStatus.enum.pending} AND a.served`;
    const queries = shortcodeEntities
      .filter((entity) => !scope.record || scope.record.entity === entity)
      .map((entity) => {
        const table = SHORTCODE_TABLE[entity];
        return selectWorkCandidates(db, source, {
          entity,
          id: sql`${table.shortcode}`,
          name: labelSql(entity, `"${getTableName(table)}"`),
          reason: "Pending suggestions",
          reasonKeys: sql`ARRAY(SELECT DISTINCT pending.reason_key FROM work_pending_suggestions pending WHERE pending.entity = ${entity} AND (pending.record_id = ${outer(table.id)}::text OR pending.record_id = ${outer(table.shortcode)}::text) ORDER BY pending.reason_key)`,
          ...recordAuthority(entity, outer(table.id)),
          ...workRecordFactsFor(entity),
        })
          .from(table)
          .where(
            and(
              "deletedAt" in table ? notDeleted(table) : undefined,
              recordScope(scope, sql`${table.shortcode}`),
              sql`EXISTS (SELECT 1 FROM work_pending_suggestions pending WHERE pending.entity = ${entity} AND (pending.record_id = ${outer(table.id)}::text OR pending.record_id = ${outer(table.shortcode)}::text))`,
            ),
          );
      });
    return {
      query: sql.join(
        queries.map((query) => sql`(${query})`),
        sql` UNION ALL `,
      ),
      ctes: [
        { name: "work_statement_state", sql: pendingStatementStateSql() },
        {
          name: "work_connection_prediction",
          sql: sql`SELECT a.id, a.subject, a.fingerprint, coalesce(s.data->'connectionTarget', a.evidence->'candidate'->${"target"}) AS target FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id WHERE a.served AND s.family = ${assessmentFamily.enum.recommendation} AND s.active AND s.status = ${suggestionStatus.enum.pending} AND a.subject->>'scope' LIKE 'connection.%'`,
        },
        { name: "work_pending_suggestions", sql: pending },
      ],
    };
  },
};
export const pendingSuggestionsWorkSource = source;
