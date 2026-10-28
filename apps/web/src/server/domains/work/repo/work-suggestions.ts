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
import {
  entityIdentity,
  assessmentState,
  financialAccount,
} from "~/server/db/schema";
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
} from "~/server/domains/transaction-import/repo/statement-charge";
import { workRecordFactsFor } from "~/server/domains/work/repo/record-facts";
import {
  pendingImageDescriptionEligibility,
  reviewFamilyDeclarations,
} from "~/server/generic/assessment/repo/review-families";
import { reviewableSuggestionSql } from "~/server/generic/assessment/repo/suggestion-review";
import { labelSql } from "~/server/generic/entity-graph/repo/record-label";
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
  link: { kind: "suggestions" },
  reasons: Object.entries({
    field: "Pending field suggestions",
    image_description: "Pending image descriptions",
    recommendation: "Pending connection suggestions",
    statement_transaction: "Pending statement transactions",
    transfer_pair: "Pending transfer pairs",
  }).map(([family, label]) => ({ key: `suggestions:${family}`, label })),
  candidates: async (db, scope) => {
    const target = (field: "entityId" | "entityKind") =>
      sql`prediction.target->>${field}`;
    const subject = alias(entityIdentity, "work_subject");
    const subjectId = scope.record
      ? sql`(SELECT work_subject.id FROM "Entity" work_subject
      WHERE work_subject.kind = ${scope.record.entity} AND work_subject.shortcode = ${scope.record.id}
        AND ${notDeleted(subject)} AND work_subject."mergedIntoId" IS NULL)`
      : undefined;
    const stateScope = (alias: string) =>
      scope.record
        ? sql`${sql.identifier(alias)}.entity = ${scope.record.entity} AND ${sql.identifier(alias)}."recordId" = ${subjectId}`
        : sql`true`;
    const connectionScope = scope.record
      ? sql`((root.kind = ${scope.record.entity} AND root.shortcode = ${scope.record.id})
        OR (other.kind = ${scope.record.entity} AND other.shortcode = ${scope.record.id}))`
      : sql`true`;
    const connectionWhere = sql`current.family = ${assessmentFamily.enum.recommendation} AND current.active AND current.status = ${suggestionStatus.enum.pending}
      AND prediction.subject->>'scope' LIKE 'connection.%'
      AND ${notDeleted(alias(entityIdentity, "root"))} AND root."mergedIntoId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Feedback" reviewed WHERE reviewed."assessmentId" = prediction.id
        AND reviewed.authority = ${feedbackAuthority.enum.member} AND reviewed.verdict IN (${feedbackVerdict.enum.wrong}, ${feedbackVerdict.enum.dismissed}))
      AND NOT EXISTS (SELECT 1 FROM "AssessmentState" hidden WHERE hidden.active AND hidden.entity = current.entity
        AND hidden."recordId" = current."recordId" AND hidden.suppression->>'scope' = prediction.subject->>'scope'
        AND hidden.suppression->>'candidateKey' = prediction.subject->>'candidateKey'
        AND (hidden.suppression->>'fingerprint' IS NULL OR hidden.suppression->>'fingerprint' = prediction.fingerprint))
      AND ${notDeleted(alias(entityIdentity, "other"))} AND other."mergedIntoId" IS NULL AND ${connectionScope}`;
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
          scope.record
            ? sql`${assessmentState.entity} = ${scope.record.entity} AND ${assessmentState.recordId} = ${subjectId}`
            : undefined,
          reviewableSuggestionSql,
        ),
      );
    const account = alias(financialAccount, "statement_account");
    // One indexed, short-circuiting eligibility probe per admitted account.
    // A Product detail never opens the statement population at all.
    const statements =
      !scope.record || scope.record.entity === "financialAccount"
        ? sql`SELECT ${entitySchema.enum.financialAccount}::text, statement_account.id::text, ${"suggestions:statement_transaction"}::text
          FROM "FinancialAccount" statement_account
          CROSS JOIN LATERAL (
            SELECT 1 FROM (${pendingStatementStateSql(sql`statement_account.id::text`)}) s
            WHERE ${pendingSuggestion("s")} LIMIT 1
          ) eligible
          WHERE ${and(notDeleted(account), recordScope(scope, sql`statement_account.shortcode`))}`
        : sql`SELECT NULL::text, NULL::text, NULL::text WHERE false`;
    const pending = sql`${field}
      UNION ALL SELECT s.entity, s."recordId"::text, ${"suggestions:image_description"}::text FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id WHERE ${pendingImageDescriptionEligibility()} AND ${stateScope("s")}
      UNION ALL SELECT root_entity, root_id::text, ${"suggestions:recommendation"}::text FROM work_connection_suggestions
      UNION ALL SELECT other_entity, other_id::text, ${"suggestions:recommendation"}::text FROM work_connection_suggestions
      UNION ALL ${statements}
      UNION ALL SELECT refs.value->>'entity', refs.value->>'id', ${"suggestions:transfer_pair"}::text FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id
        CROSS JOIN LATERAL jsonb_array_elements(${reviewFamilyDeclarations.transfer_pair.records}) refs(value)
        WHERE s.family = ${assessmentFamily.enum.transfer_pair} AND s.active AND s.status = ${suggestionStatus.enum.pending} AND a.served AND ${
          scope.record
            ? sql`refs.value->>'entity' = ${scope.record.entity} AND (refs.value->>'id' = ${scope.record.id} OR refs.value->>'id' = ${subjectId}::text)`
            : sql`true`
        }`;
    const identity = alias(entityIdentity, "work_identity");
    const queries = shortcodeEntities
      .filter((entity) => !scope.record || scope.record.entity === entity)
      .map((entity) => {
        const table = SHORTCODE_TABLE[entity];
        return selectWorkCandidates(db, source, {
          entity,
          id: sql`${table.shortcode}`,
          name: labelSql(entity, `"${getTableName(table)}"`),
          reason: "Pending suggestions",
          reasonKeys: sql`pending.reason_keys`,
          ...recordAuthority(entity, outer(table.id)),
          ...workRecordFactsFor(entity),
        })
          .from(table)
          .innerJoin(
            sql`work_pending_records pending`,
            sql`pending.entity = ${entity} AND pending.record_id = ${table.id}`,
          )
          .where(
            and(
              "deletedAt" in table ? notDeleted(table) : undefined,
              recordScope(scope, sql`${table.shortcode}`),
            ),
          );
      });
    return {
      query: sql.join(
        queries.map((query) => sql`(${query})`),
        sql` UNION ALL `,
      ),
      ctes: [
        {
          name: "work_connection_prediction",
          // Migration 0042 and connection publication own this compact target.
          // Reverse-target reads must not reopen immutable evidence per candidate.
          sql: sql`SELECT a.id, a.subject, a.fingerprint, s.data->'connectionTarget' AS target FROM "Assessment" a JOIN "AssessmentState" s ON s.id = a.id WHERE a.served AND s.family = ${assessmentFamily.enum.recommendation} AND s.active AND s.status = ${suggestionStatus.enum.pending} AND a.subject->>'scope' LIKE 'connection.%' AND ${
            scope.record
              ? sql`((${stateScope("s")}) OR (s.data->'connectionTarget'->>'entityKind' = ${scope.record.entity}
              AND s.data->'connectionTarget'->>'entityId' = ${scope.record.id}))`
              : sql`true`
          }`,
        },
        {
          name: "work_connection_suggestions",
          sql: sql`SELECT root.kind AS root_entity, root.id AS root_id, other.kind AS other_entity, other.id AS other_id
            FROM ${connectionFrom} WHERE ${connectionWhere}`,
        },
        { name: "work_pending_suggestions", sql: pending },
        {
          name: "work_pending_records",
          // Normalize both internal IDs and public codes once. Joining this
          // compact identity set avoids rescanning pending work per live row.
          sql: sql`SELECT identity.kind AS entity, identity.id AS record_id, array_agg(DISTINCT reason.reason_key ORDER BY reason.reason_key) AS reason_keys
            FROM (SELECT entity, record_id, array_agg(DISTINCT reason_key) AS reason_keys
              FROM work_pending_suggestions GROUP BY entity, record_id) pending
            CROSS JOIN LATERAL (
              SELECT id, kind FROM "Entity" work_identity
              WHERE kind = pending.entity AND ${notDeleted(identity)} AND id = CASE WHEN pending.record_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN pending.record_id::uuid END
              UNION ALL SELECT id, kind FROM "Entity" work_identity
              WHERE kind = pending.entity AND ${notDeleted(identity)} AND shortcode = pending.record_id
              LIMIT 1
            ) identity
            CROSS JOIN LATERAL unnest(pending.reason_keys) reason(reason_key)
            GROUP BY identity.kind, identity.id`,
        },
      ],
    };
  },
};
export const pendingSuggestionsWorkSource = source;
