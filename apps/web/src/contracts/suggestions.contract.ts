import {
  automaticDecisionListInput,
  automaticDecisionListOut,
} from "@cubby/schemas/automatic-decision";
import {
  acceptCleanSuggestionsInput,
  acceptCleanSuggestionsOut,
  suggestionCountsInput,
  suggestionCountsOut,
  suggestionListInput,
  suggestionListOut,
} from "@cubby/schemas/suggestion-list";

import { defineContract, mutation, query } from "~/contracts/define";

/** Pending Suggestions of every family; review goes through `suggestion.review(Batch)`. */
export const suggestionsContract = defineContract(
  "suggestions",
  {
    automaticDecisions: query({
      description:
        "Already-applied decisions, newest first: Email relevance, automatic Email links, mail-import outcomes, and automatic-rule applications. Filter by family, recordIds and reviewStatus. Wrong records member Feedback through suggestions.review. Declared correction options use verdict wrong, intent apply, correction and expectedFingerprint; without a correction use intent history. Mail-import outcomes are history only; correct affected records through their domain actions. Decisions stay in this audit after review.",
      input: automaticDecisionListInput,
      output: automaticDecisionListOut,
      cache: { tags: [["suggestions"]] },
    }),
    list: query({
      description:
        "The shared proposal queue: fields, statement transactions, connections and tag additions, Product pairs, image descriptions, and transfer pairs. Non-actionable candidates and already-applied automatic decisions are excluded. Scope by family, recordEntity, recordIds (every touched endpoint), runId and column filters. Declared filters accept include values, <column>Exclude values, <column>Presence and range <column>From/<column>To bounds; every supplied predicate must hold. Exclude keeps rows with no matching value, including null or absent values. Rows declare evidence, Strength, clean, actions, merge confirmation data and suppression. Review through suggestions.review (items, one or many), preserving expectedFingerprint and the declared application. Product merges require survivor choice and impact review; only clean rows qualify for bulk acceptance. Confidence never authorizes apply.",
      input: suggestionListInput,
      output: suggestionListOut,
      cache: {
        tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
      },
    }),
    counts: query({
      exposure: "view",
      note: "Suggestions page and Run counts; agents read rows through suggestions_read.list",
      input: suggestionCountsInput,
      output: suggestionCountsOut,
      cache: {
        tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
      },
    }),
    acceptClean: mutation({
      exposure: "view",
      note: "Agents accept each clean row through suggestions.review",
      command: { label: "Accept clean suggestions", confirmation: null },
      input: acceptCleanSuggestionsInput,
      output: acceptCleanSuggestionsOut,
      invalidates: [
        "suggestions",
        "product",
        "expense",
        "purchase",
        "vendor",
        "task",
        "project",
        "inventory",
        "cookbook",
        "sourceTransactionRecord",
        "financialTransaction",
        "settledSuggestions",
      ],
    }),
  },
  { exposure: "capability" },
);
