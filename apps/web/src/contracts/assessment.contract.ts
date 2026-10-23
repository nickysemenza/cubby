import {
  assessmentReviewInput,
  assessmentReviewOut,
  assessmentReviewBatchInput,
  assessmentReviewBatchOut,
} from "@cubby/schemas/assessment";

import { defineContract, mutation } from "~/contracts/define";

export const assessmentContract = defineContract(
  "assessment",
  {
    review: mutation({
      description:
        "Review immutable evidence as correct, wrong, uncertain or a presentation dismissal. Draft review does not apply; saved application is revalidated.",
      input: assessmentReviewInput,
      output: assessmentReviewOut,
      invalidates: [
        "product",
        "expense",
        "purchase",
        "vendor",
        "email",
        "image",
        "recommendations",
        "settledSuggestions",
        "suggestions",
        "connections",
        "task",
        "project",
        "inventory",
        "cookbook",
        "sourceTransactionRecord",
        "financialTransaction",
      ],
      native: "Review an Assessment, with optional saved application",
    }),
    reviewBatch: mutation({
      description:
        "Review Assessments independently; each item returns its own outcome.",
      command: { label: "Review suggestions", confirmation: null },
      input: assessmentReviewBatchInput,
      output: assessmentReviewBatchOut,
      invalidates: [
        "product",
        "expense",
        "purchase",
        "vendor",
        "email",
        "image",
        "recommendations",
        "settledSuggestions",
        "suggestions",
        "connections",
        "task",
        "project",
        "inventory",
        "cookbook",
        "sourceTransactionRecord",
        "financialTransaction",
      ],
      native: "Settle Assessment reviews independently",
    }),
  },
  { exposure: "capability", mcpToolGroup: "suggestions" },
);
