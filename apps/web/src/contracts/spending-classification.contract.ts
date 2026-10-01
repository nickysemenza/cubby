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
      input: z.object({ request: spendingClassificationReviewInput }),
      output: spendingClassificationReviewPreview,
      transport: "post",
      readPolicy: "strong",
      native: "Preview historical spending classification changes",
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
      input: spendingClassificationReviewApplyInput,
      output: spendingClassificationReviewResult,
      native: "Apply an unchanged reviewed spending classification change",
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
);
