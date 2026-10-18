import { assessmentReviewBatchOut } from "@cubby/schemas/assessment";
import {
  acceptCleanSuggestionsInput,
  suggestionCountsInput,
  suggestionCountsOut,
  suggestionListInput,
  suggestionListOut,
} from "@cubby/schemas/suggestion-list";

import { defineContract, mutation, query } from "~/contracts/define";

/** Pending Suggestions of every family; review goes through `assessment.review(Batch)`. */
export const suggestionsContract = defineContract("suggestions", {
  list: query({
    input: suggestionListInput,
    output: suggestionListOut,
    readPolicy: "strong",
    transport: "post",
    cache: {
      profile: "stable",
      tags: [["suggestions"], ["statementRow"], ["connections"]],
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
      tags: [["suggestions"], ["statementRow"], ["connections"]],
    },
  }),
  acceptClean: mutation({
    mcp: {
      omit: "agent_twin",
      twin: "assessment.reviewBatch",
      note: "Agents accept each clean row through entity.review_assessments",
    },
    input: acceptCleanSuggestionsInput,
    output: assessmentReviewBatchOut,
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
      "statementRow",
      "financialTransaction",
      "settledSuggestions",
    ],
  }),
});
