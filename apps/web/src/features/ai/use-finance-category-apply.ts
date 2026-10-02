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
          spendingCategoryId: suggestion.value,
        }),
      ),
    [mutateAsync],
  );
  return {
    apply,
    isPending,
  };
}
