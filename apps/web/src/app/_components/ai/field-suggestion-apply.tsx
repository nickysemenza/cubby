import type { FieldSuggestion } from "@cubby/schemas/ai";

import {
  type EntitySuggestionsOperations,
  type FieldSuggestionSource,
  useEntitySuggestionsQuery,
} from "./field-suggestion";
import { FieldSuggestionHint } from "./field-suggestion-hint";

/**
 * The query-layer half of the hint, for surfaces with no RHF form to hang a
 * `FieldSuggestionProvider` off of — cell editors, split-expense, add-to-meal.
 * Runs its own `useEntitySuggestionsQuery` (typically for one target) rather
 * than reading a provider's context, and leaves the write itself to the
 * caller's own picker/setter through `onApply`.
 */
export function FieldSuggestionApply({
  source,
  currentValue,
  onApply,
  operations,
}: {
  source: FieldSuggestionSource | null;
  /** The field's current raw value, compared against the suggestion to
   * decide whether it's already applied. */
  currentValue: string | null;
  onApply: (suggestion: FieldSuggestion) => void;
  operations?: EntitySuggestionsOperations;
}) {
  const { suggestions, isFetching } = useEntitySuggestionsQuery({
    source,
    operations,
  });
  const targetKey = source?.targets[0];
  const suggestion = targetKey ? (suggestions[targetKey] ?? null) : null;
  const applied = Boolean(
    suggestion?.value && currentValue === suggestion.value,
  );

  return (
    <FieldSuggestionHint
      suggestion={suggestion}
      applied={applied}
      pending={isFetching}
      onApply={suggestion ? () => onApply(suggestion) : undefined}
    />
  );
}
