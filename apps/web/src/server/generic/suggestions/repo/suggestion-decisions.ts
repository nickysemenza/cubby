import {
  suggestionDecision,
  type SuggestionDecision,
} from "@cubby/schemas/suggestion";
import { z } from "zod";

/** A retained decision with its Suggestion, the shape receipt checks compare. */
export type StoredDecision = SuggestionDecision & { suggestionId: string };

export const storedDecisions = (
  suggestionId: string,
  decisions: unknown,
): StoredDecision[] =>
  z
    .array(suggestionDecision)
    .parse(decisions)
    .map((decision) => ({ ...decision, suggestionId }));

/** The decision an operation recorded on this Suggestion, if any. */
export const decisionForOperation = (
  suggestionId: string,
  decisions: readonly SuggestionDecision[] | undefined,
  operationId: string,
): StoredDecision | undefined =>
  storedDecisions(suggestionId, decisions ?? []).find(
    (decision) => decision.operationId === operationId,
  );
