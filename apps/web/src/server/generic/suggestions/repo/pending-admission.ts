import { and, eq, isNull, notExists, or, sql } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

import { suggestionTable } from "~/server/db/retained-tables";
import { memberRejectedSql } from "~/server/generic/suggestions/repo/suggestion-decisions";

export type SuggestionRecordSelection = {
  entity?: string;
  records?: readonly { code: string; entity: string; id: string }[];
};

export const recommendationScopes = {
  connection: sql`s.subject->>'scope' LIKE 'connection.%'`,
};

const reviewSuggestion = alias(suggestionTable, "s");
const reviewState = reviewSuggestion;
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
      ? sql`NOT ${memberRejectedSql(sql`${reviewSuggestion.decisions}`)}`
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
              sql<string>`${reviewSuggestion.subject}->>'scope'`,
            ),
            eq(
              suppressionValue("candidateKey"),
              sql<string>`${reviewSuggestion.subject}->>'candidateKey'`,
            ),
            or(
              isNull(suppressionValue("fingerprint")),
              eq(suppressionValue("fingerprint"), reviewSuggestion.fingerprint),
            ),
          ),
        ),
    ),
  );
}
