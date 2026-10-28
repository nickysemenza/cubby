import type { FieldSuggestion } from "@cubby/schemas/ai";
import { useQueryClient } from "@tanstack/react-query";
import { useContext } from "react";

import { renderSuggestedListFieldValue } from "~/entity/display/entity-display";
import { useEntityMetadata } from "~/entity/metadata";
import { assessment } from "~/integrations/tanstack-query/domains/assessment";

import {
  type EntitySuggestionsOperations,
  type FieldSuggestionSource,
  useEntitySuggestionsQuery,
} from "./field-suggestion";
import { FieldSuggestionHint } from "./field-suggestion-hint";
import { RecordSuggestionScope } from "./record-suggestions";
import { useFinanceCategoryApply } from "./use-finance-category-apply";

/**
 * The query-layer half of the hint, for surfaces with no RHF form to hang a
 * `FieldSuggestionProvider` off of — cell editors, split-expense, add-to-meal.
 * Runs its own `useEntitySuggestionsQuery` (typically for one target) rather
 * than reading a provider's context, and leaves the write itself to the
 * caller's own picker/setter through `onApply`.
 */
type ApplyProps = {
  source: FieldSuggestionSource | null;
  currentValue: string | null;
  onApply: (suggestion: FieldSuggestion) => void | Promise<void>;
  operations?: EntitySuggestionsOperations;
};

export function FieldSuggestionApply(props: ApplyProps) {
  const row = useContext(RecordSuggestionScope);
  if (
    row &&
    props.source?.targets.every((target) => row.sourceByField.has(target))
  )
    return null;
  if (!props.source) return null;
  return <StandaloneSuggestion {...props} source={props.source} />;
}

function StandaloneSuggestion({
  source,
  currentValue,
  onApply,
  operations,
}: ApplyProps & { source: FieldSuggestionSource }) {
  useEntityMetadata(source.entity);
  const queryClient = useQueryClient();
  const financeApply = useFinanceCategoryApply(operations);
  const { suggestions, outcomes, isFetching, refetch } =
    useEntitySuggestionsQuery({
      source,
      operations,
    });
  const targetKey = source?.targets[0];
  const suggestion = targetKey ? (suggestions[targetKey] ?? null) : null;
  const outcome = targetKey ? (outcomes[targetKey] ?? null) : null;
  const applied = Boolean(
    suggestion?.value && currentValue === suggestion.value,
  );

  return (
    <FieldSuggestionHint
      renderValue={
        source && targetKey
          ? (value, label) =>
              renderSuggestedListFieldValue(
                queryClient,
                source.entity,
                { id: source.entityId ?? "" },
                targetKey,
                value,
                label,
              )
          : undefined
      }
      currentValue={currentValue}
      questionKey={JSON.stringify(source)}
      suggestion={suggestion}
      applied={applied}
      pending={isFetching}
      onApply={
        suggestion
          ? async () => {
              if (!suggestion.assessmentId)
                throw new Error("Suggestion Assessment is missing");
              await assessment.review.call({
                assessmentId: suggestion.assessmentId,
                operationId: crypto.randomUUID(),
                verdict: "correct",
                intent: "draft",
              });
              if (!suggestion.financeReview) return onApply(suggestion);
              try {
                await financeApply.apply(suggestion);
                await assessment.review.call({
                  assessmentId: suggestion.assessmentId,
                  operationId: crypto.randomUUID(),
                  verdict: "correct",
                  intent: "apply",
                  application: {
                    kind: "saved_field",
                    recordId: suggestion.financeReview.entityId,
                  },
                });
              } catch (error) {
                await refetch();
                throw error;
              }
            }
          : undefined
      }
      alternative={source?.basisMode === "provided"}
      outcome={outcome}
      surface="line"
    />
  );
}
