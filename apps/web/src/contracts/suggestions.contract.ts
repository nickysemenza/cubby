import {
  automaticDecisionListInput,
  automaticDecisionListOut,
  suggestionRecordCountsInput,
  suggestionRecordCountsOut,
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
      readPolicy: "strong",
      cache: { profile: "stable", tags: [["suggestions"]] },
    }),
    recordCounts: query({
      exposure: "view",
      note: "Per-row counts; agents read scoped suggestions_read.list rows",
      input: suggestionRecordCountsInput,
      output: suggestionRecordCountsOut,
      readPolicy: "strong",
      cache: {
        profile: "stable",
        tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
      },
    }),
    list: query({
      description:
        "The shared proposal queue: fields, statement transactions, connections and tag additions, Product pairs, image descriptions, and transfer pairs. Non-actionable candidates and already-applied automatic decisions are excluded. Scope by family, recordEntity, recordIds (every touched endpoint), runId and column filters. Declared filters accept include values, <column>Exclude values, <column>Presence and range <column>From/<column>To bounds; every supplied predicate must hold. Exclude keeps rows with no matching value, including null or absent values. Rows declare evidence, Strength, clean, actions, merge confirmation data and suppression. Review through suggestions.review or suggestions.review_batch, preserving expectedFingerprint and the declared application. Product merges require survivor choice and impact review; only clean rows qualify for bulk acceptance. Confidence never authorizes apply.",
      input: suggestionListInput,
      output: suggestionListOut,
      readPolicy: "strong",
      cache: {
        profile: "stable",
        tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
      },
    }),
    counts: query({
      exposure: "view",
      note: "Suggestions page and Run counts; agents read rows through suggestions_read.list",
      input: suggestionCountsInput,
      output: suggestionCountsOut,
      readPolicy: "strong",
      cache: {
        profile: "stable",
        tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
      },
    }),
    acceptClean: mutation({
      exposure: "view",
      note: "Agents accept each clean row through suggestions.review_batch",
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
