import type { FieldSuggestion } from "@cubby/schemas/ai";
import { useContext } from "react";

import {
  type EntitySuggestionsOperations,
  type FieldSuggestionSource,
  useEntitySuggestionsQuery,
} from "./field-suggestion";
import { FieldSuggestionHint } from "./field-suggestion-hint";
import { RecordSuggestionScope } from "./record-suggestions";

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
    props.source?.targets.every((target) => row.source.targets.includes(target))
  )
    return null;
  return <StandaloneSuggestion {...props} />;
}

function StandaloneSuggestion({
  source,
  currentValue,
  onApply,
  operations,
}: ApplyProps) {
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
      currentValue={currentValue}
      questionKey={JSON.stringify(source)}
      suggestion={suggestion}
      applied={applied}
      pending={isFetching}
      onApply={suggestion ? () => onApply(suggestion) : undefined}
    />
  );
}
