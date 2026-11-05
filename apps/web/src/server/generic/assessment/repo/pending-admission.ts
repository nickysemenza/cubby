import { and, eq, isNull, notExists, or, sql } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

import { suggestionTable } from "~/server/db/retained-tables";
import { memberRejectedSql } from "~/server/generic/assessment/repo/suggestion-decisions";

export type AssessmentRecordSelection = {
  entity?: string;
  records?: readonly { code: string; entity: string; id: string }[];
};

export const recommendationScopes = {
  connection: sql`s.subject->>'scope' LIKE 'connection.%'`,
  tagPropagation: sql`s.subject->>'scope' = 'product.tag-propagation'`,
};

const reviewAssessment = alias(suggestionTable, "s");
const reviewState = reviewAssessment;
const reviewQueryBuilder = new QueryBuilder();
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
