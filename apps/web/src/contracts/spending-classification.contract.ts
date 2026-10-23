import {
  spendingClassificationReviewApplyInput,
  spendingClassificationReviewInput,
  spendingClassificationReviewPreview,
  spendingClassificationReviewResult,
} from "@cubby/schemas/spending-classification-review";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

export const spendingClassificationContract = defineContract(
  "spendingClassification",
  {
    preview: query({
      description:
        "Nonmutating historical impact preview. Supply one complete Product Category mapping, Vendor spending policy, selected Expense category assignment/reset, or Spending Category merge (`spendingCategoryMerge` with keepId and mergeIds; entity.merge refuses one that moves Expense history). Returns signed exact-cent category totals and deltas including shared adjustments, unknown coverage, and a fingerprint. Review before applying; stored source evidence and Expense amounts remain unchanged.",
      input: z.object({ request: spendingClassificationReviewInput }),
      output: spendingClassificationReviewPreview,
      readPolicy: "strong",
      cache: {
        tags: [
          ["expense"],
          ["purchase"],
          ["product"],
          ["productCategory"],
          ["vendor"],
          ["spendingCategory"],
        ],
      },
    }),
    apply: mutation({
      description:
        "Apply the exact reviewed request and fingerprint atomically. Refuses when policy or historical facts changed since preview. Mapping changes stay live historically; explicit Expense assignments win and null resets to inheritance. Never creates financial bookings or changes Expense amounts.",
      input: spendingClassificationReviewApplyInput,
      output: spendingClassificationReviewResult,
      invalidates: [
        "expense",
        "purchase",
        "financialTransaction",
        "product",
        "productCategory",
        "vendor",
        "spendingCategory",
      ],
    }),
  },
  { exposure: "capability", mcpToolGroup: "spending_classification_write" },
);
