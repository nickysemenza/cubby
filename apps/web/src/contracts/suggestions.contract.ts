import {
  automaticDecisionListInput,
  automaticDecisionListOut,
  suggestionRecordCountsInput,
  suggestionRecordCountsOut,
} from "@cubby/schemas/automatic-decision";
import {
  automaticRuleOut,
  automaticRulesOut,
  setAutomaticRuleInput,
} from "@cubby/schemas/automatic-rule";
import {
  acceptCleanSuggestionsInput,
  acceptCleanSuggestionsOut,
  suggestionCountsInput,
  suggestionCountsOut,
  suggestionListInput,
  suggestionListOut,
} from "@cubby/schemas/suggestion-list";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

/** Pending Suggestions of every family; review goes through `assessment.review(Batch)`. */
export const suggestionsContract = defineContract("suggestions", {
  automaticDecisions: query({
    input: automaticDecisionListInput,
    output: automaticDecisionListOut,
    readPolicy: "strong",
    transport: "post",
    cache: { profile: "stable", tags: [["suggestions"]] },
  }),
  recordCounts: query({
    input: suggestionRecordCountsInput,
    output: suggestionRecordCountsOut,
    mcp: {
      omit: "client_view",
      note: "Per-row counts; agents read scoped suggestion_queue rows",
    },
    readPolicy: "strong",
    transport: "post",
    cache: {
      profile: "stable",
      tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
    },
  }),
  list: query({
    input: suggestionListInput,
    output: suggestionListOut,
    readPolicy: "strong",
    transport: "post",
    cache: {
      profile: "stable",
      tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
    },
  }),
  counts: query({
    mcp: {
      omit: "client_view",
      note: "Suggestions page and Run counts; agents read rows through suggestion_queue",
    },
    input: suggestionCountsInput,
    output: suggestionCountsOut,
    readPolicy: "strong",
    transport: "post",
    cache: {
      profile: "stable",
      tags: [["suggestions"], ["sourceTransactionRecord"], ["connections"]],
    },
  }),
  acceptClean: mutation({
    command: { label: "Accept clean suggestions", confirmation: null },
    mcp: {
      omit: "agent_twin",
      twin: "assessment.reviewBatch",
      note: "Agents accept each clean row through entity.review_assessments",
    },
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
  /** Each Automatic rule with its switch and precision, computed on read. */
  rules: query({
    input: z.object({}).strict(),
    output: automaticRulesOut,
    readPolicy: "strong",
    cache: { profile: "stable", tags: [["suggestions"]] },
  }),
  /** A member's switch: on requires eligibility, off is always allowed. */
  setRule: mutation({
    command: { label: "Set automatic rule", confirmation: null },
    input: setAutomaticRuleInput,
    output: automaticRuleOut,
    invalidates: ["suggestions"],
  }),
});
