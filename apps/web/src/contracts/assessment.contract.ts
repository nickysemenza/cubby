import {
  assessmentReviewInput,
  assessmentReviewOut,
  assessmentReviewBatchInput,
  assessmentReviewBatchOut,
} from "@cubby/schemas/assessment";

import { defineContract, mutation } from "~/contracts/define";

export const assessmentContract = defineContract("assessment", {
  review: mutation({
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
    ],
    native: "Review an Assessment, with optional saved application",
  }),
  reviewBatch: mutation({
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
    ],
    native: "Settle Assessment reviews independently",
  }),
});
