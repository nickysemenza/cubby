import {
  financeCategoryApplyInput,
  type FieldSuggestion,
} from "@cubby/schemas/ai";
import { useMutation } from "@tanstack/react-query";
import { useCallback } from "react";

import { ai } from "~/integrations/tanstack-query/generated/catalog.gen";

import type { EntitySuggestionsOperations } from "./field-suggestion";

/** The review surface owns errors; only explicit approval calls this mutation. */
export function useFinanceCategoryApply(
  operations?: EntitySuggestionsOperations,
) {
  const operation =
    operations?.applyFinanceCategorySuggestion ??
    ai.applyFinanceCategorySuggestion;
  const { mutateAsync, isPending } = useMutation(operation.mutationOptions());
  const apply = useCallback(
    (suggestion: FieldSuggestion) =>
      mutateAsync(
        financeCategoryApplyInput.parse({
          ...suggestion.financeReview,
          [suggestion.financeReview?.field ?? "spendingCategoryId"]:
            suggestion.value,
        }),
      ),
    [mutateAsync],
  );
  const applyMany = useCallback(
    (suggestions: readonly FieldSuggestion[]) => {
      const review = suggestions[0]?.financeReview;
      if (
        !review ||
        suggestions.some(
          (item) =>
            item.financeReview?.fingerprint !== review.fingerprint ||
            item.financeReview?.entityId !== review.entityId ||
            item.financeReview?.entity !== review.entity,
        )
      )
        throw new Error(
          "Review the same saved record before applying suggestions together.",
        );
      return mutateAsync(
        financeCategoryApplyInput.parse({
          ...review,
          ...Object.fromEntries(
            suggestions.map((item) => [
              item.financeReview?.field ?? "spendingCategoryId",
              item.value,
            ]),
          ),
        }),
      );
    },
    [mutateAsync],
  );
  return {
    applyMany,
    apply,
    isPending,
  };
}
