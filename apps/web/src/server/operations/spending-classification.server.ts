import { spendingClassificationContract } from "~/contracts/spending-classification.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  applySpendingClassificationReview,
  previewSpendingClassificationReview,
} from "~/server/repo/spending-classification-review";

export const spendingClassificationHandlers = implementOperationDomain(
  spendingClassificationContract,
  {
    preview: (context, input) =>
      previewSpendingClassificationReview(context.db, input),
    apply: (context, input) =>
      applySpendingClassificationReview(context, input),
  },
);
