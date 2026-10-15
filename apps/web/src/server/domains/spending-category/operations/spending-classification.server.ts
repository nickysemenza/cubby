import { spendingClassificationContract } from "~/contracts/spending-classification.contract";
import {
  applySpendingClassificationReview,
  previewSpendingClassificationReview,
} from "~/server/domains/spending-category/repo/spending-classification-review";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";

export const spendingClassificationHandlers = implementOperationDomain(
  spendingClassificationContract,
  {
    preview: (context, input) =>
      previewSpendingClassificationReview(context.db, input.request),
    apply: (context, input) =>
      applySpendingClassificationReview(context, input),
  },
);
