import { suggestionStatus } from "@cubby/schemas/ai";
import {
  assessmentFamily,
} from "@cubby/schemas/assessment";
import { entitySchema, type Entity } from "@cubby/schemas/entity";
import { suggestionListFamily } from "@cubby/schemas/suggestion-list";
import {
  and,
  eq,
  isNull,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

import { outer, related } from "~/server/db/helpers/related";
import { memberRejectedSql } from "~/server/generic/assessment/repo/suggestion-decisions";
import {
  suggestionTable,
  entityIdentity,
} from "~/server/db/retained-tables";

export type AssessmentRecordSelection = {
  entity?: string;
  records?: readonly { code: string; entity: string; id: string }[];
};

export const recommendationScopes = {
  connection: sql`s.subject->>'scope' LIKE 'connection.%'`,
  tagPropagation: sql`s.subject->>'scope' = 'product.tag-propagation'`,
};

/** Current endpoint identities reach new advice before reverse dependencies exist. */
export function assessmentSourceRecordIdsSql(kind: Entity, refs: SQL): SQL {
  const families = sql.join(
    suggestionListFamily.options.map((family) => sql`${family}`),
    sql`, `,
  );
  const point = (end: "source" | "target") => {
    // Literal paths match the existing endpoint indexes, including generic plans.
    const entity =
      end === "source"
        ? sql`s.evidence #>> '{candidate,source,entityKind}'`
        : sql`s.evidence #>> '{candidate,target,entityKind}'`;
    const id =
      end === "source"
        ? sql`s.evidence #>> '{candidate,source,entityId}'`
        : sql`s.evidence #>> '{candidate,target,entityId}'`;
    return sql`SELECT s.id FROM source_record_identities requested
      CROSS JOIN LATERAL (VALUES (requested.shortcode), (requested.id::text)) token(value)
      CROSS JOIN LATERAL (
        SELECT s.id FROM ${suggestionTable} s WHERE s.served
          AND ${recommendationScopes.connection} AND ${entity} = ${kind} AND ${id} = token.value
        OFFSET 0
      ) matched JOIN ${suggestionTable} s ON s.id = matched.id
      WHERE s.active AND s.status = ${suggestionStatus.enum.pending}`;
  };
  return sql`WITH source_record_ids AS MATERIALIZED (${refs}),
    source_record_identities AS MATERIALIZED (
      SELECT id, shortcode FROM ${entityIdentity} WHERE kind = ${kind}
        AND id IN (SELECT id FROM source_record_ids)
    ) SELECT s.id FROM ${suggestionTable} s
      WHERE s.active
      AND s.status = ${suggestionStatus.enum.pending} AND s.entity = ${kind}
      AND s.family IN (${families})
      AND s."recordId" IN (SELECT id FROM source_record_ids)
    UNION ${point("source")} UNION ${point("target")}`;
}

const reviewAssessment = alias(suggestionTable, "s");
const reviewState = reviewAssessment;
const reviewQueryBuilder = new QueryBuilder();
const entities = entitySchema.enum;
/** Member rejection and current suppression independently remove pending connections. */
export function pendingRecommendationEligibility({
  memberFeedback = true,
}: { memberFeedback?: boolean } = {}) {
  const suppressed = alias(suggestionTable, "suppressed");
  const suppressionValue = (key: "scope" | "candidateKey" | "fingerprint") =>
    sql<string>`${suppressed.suppression}->>${key}`;
  return and(
    memberFeedback
      ? sql`NOT ${memberRejectedSql(sql`${reviewAssessment.decisions}`)}`
      : undefined,
    notExists(
      reviewQueryBuilder
        .select({ id: suppressed.id })
        .from(suppressed)
        .where(
          and(
            suppressed.active,
            eq(suppressed.entity, reviewState.entity),
            eq(suppressed.recordId, reviewState.recordId),
            eq(
              suppressionValue("scope"),
              sql<string>`${reviewAssessment.subject}->>'scope'`,
            ),
            eq(
              suppressionValue("candidateKey"),
              sql<string>`${reviewAssessment.subject}->>'candidateKey'`,
            ),
            or(
              isNull(suppressionValue("fingerprint")),
              eq(suppressionValue("fingerprint"), reviewAssessment.fingerprint),
            ),
          ),
        ),
    ),
  );
}

/**
 * Published admission remains a snapshot of expensive evidence checks. These
 * current authority gates can only remove it; they never admit a new result.
 * Callers join Assessment a and AssessmentState s, as the canonical readers do.
 */
export function publishedSuggestionLiveEligibility(family: SQL) {
  const primary = (kind: SQL = outer(reviewState.entity)) =>
    related(entityIdentity, (record) =>
      and(eq(record.id, outer(reviewState.recordId)), eq(record.kind, kind))!,
    ).exists();
  return and(
    reviewState.active,
    eq(reviewState.status, suggestionStatus.enum.pending),
    sql`CASE ${family}
      WHEN ${assessmentFamily.enum.field} THEN
        s.family = ${assessmentFamily.enum.field} AND s.served AND ${primary()}
      WHEN ${assessmentFamily.enum.recommendation} THEN
        s.family = ${assessmentFamily.enum.recommendation} AND s.served
        AND CASE WHEN ${recommendationScopes.connection}
          THEN ${primary()} AND ${pendingRecommendationEligibility()}
          ELSE ${primary(sql`${entities.product}`)} AND s.suppression IS NULL AND ${pendingRecommendationEligibility({ memberFeedback: false })} END
      WHEN ${assessmentFamily.enum.product_pair} THEN
        s.family = ${assessmentFamily.enum.product_pair} AND s.served AND s.suppression IS NULL AND ${primary(sql`${entities.product}`)}
      WHEN ${assessmentFamily.enum.image_description} THEN
        s.family = ${assessmentFamily.enum.image_description} AND s.served AND s.suppression IS NULL AND ${primary(sql`${entities.image}`)}
      WHEN ${assessmentFamily.enum.statement_transaction} THEN
        s.family = ${assessmentFamily.enum.statement_transaction}
      WHEN ${assessmentFamily.enum.transfer_pair} THEN
        s.family = ${assessmentFamily.enum.transfer_pair}
      ELSE false END`,
  )!;
}
