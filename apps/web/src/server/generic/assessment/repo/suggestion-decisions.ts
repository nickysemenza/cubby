import {
  suggestionDecision,
  type SuggestionDecision,
} from "@cubby/schemas/assessment";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

/** A retained decision with its Suggestion, the shape receipt checks compare. */
export type StoredDecision = SuggestionDecision & { assessmentId: string };

export const storedDecisions = (
  assessmentId: string,
  decisions: unknown,
): StoredDecision[] =>
  z
    .array(suggestionDecision)
    .parse(decisions)
    .map((decision) => ({ ...decision, assessmentId }));

/** The decision an operation recorded on this Suggestion, if any. */
export const decisionForOperation = (
  assessmentId: string,
  decisions: readonly SuggestionDecision[] | undefined,
  operationId: string,
): StoredDecision | undefined =>
  storedDecisions(assessmentId, decisions ?? []).find(
    (decision) => decision.operationId === operationId,
  );

const hasDecisionSql = (
  decisions: SQL,
  match: Partial<Record<"authority" | "verdict" | "intent", string>>,
) => sql`${decisions} @> ${JSON.stringify([match])}::jsonb`;

/** A member's Wrong, or also their Dismissal when `dismissed` is set. */
export const memberRejectedSql = (
  decisions: SQL,
  { dismissed = true }: { dismissed?: boolean } = {},
) =>
  dismissed
    ? sql`(${hasDecisionSql(decisions, { authority: "member", verdict: "wrong" })}
        OR ${hasDecisionSql(decisions, { authority: "member", verdict: "dismissed" })})`
    : hasDecisionSql(decisions, { authority: "member", verdict: "wrong" });
