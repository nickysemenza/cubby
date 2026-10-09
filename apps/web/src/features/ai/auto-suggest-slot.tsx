import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";

import { Button } from "~/ui/primitives/button";

import { FieldSuggestionHint } from "./field-suggestion-hint";
import { useFieldSuggestionContext } from "./field-suggestion-provider";
import { FormFieldResolution } from "./form-field-resolution";
import {
  useAutoFieldSuggestion,
  type UseAutoFieldSuggestionResult,
} from "./use-auto-field-suggestion";

/**
 * The `useAutoFieldSuggestion` + `FieldSuggestionHint` pairing the
 * suggest-enabled primitives (`SelectField`, `VendorField`) render the same
 * way. Mounted only when the primitive's `suggestField` prop is set — no-op
 * without a `FieldSuggestionProvider` above it, same as the hook it wraps.
 * The entity pickers (`ui/form-utils/entity-value-field.tsx`) call the hook
 * themselves, because their candidate list needs its seed items, and render
 * {@link AutoSuggestHint}.
 */
export function AutoSuggestSlot<TFieldValues extends FieldValues>({
  form,
  name,
  field,
  valueKind = "id",
  disabled,
}: {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  /** The manifest target key this field suggests, e.g. `"trade"`. */
  field: string;
  valueKind?: "id" | "item";
  disabled?: boolean;
}) {
  const context = useFieldSuggestionContext();
  const result = useAutoFieldSuggestion({
    form,
    name,
    field,
    valueKind,
    disabled,
  });
  const definition = context
    ? entityFieldModels[context.entity].fields.find(
        (item) => item.key === field,
      )
    : undefined;
  return (
    <>
      {definition?.control?.suggest?.reviewRequired &&
        context?.requestSuggestions && (
          <Button
            type="button"
            variant="link"
            size="sm"
            disabled={result.isPending || disabled}
            onClick={() => context.requestSuggestions?.()}
          >
            Suggest {definition.label.toLowerCase()}
          </Button>
        )}
      <FormFieldResolution form={form} field={field} />
      <AutoSuggestHint field={field} result={result} />
    </>
  );
}

/** One field's suggestion line, from its `useAutoFieldSuggestion` result.
 * `currentLabel` overrides the hook's own when the caller knows a better
 * label for the current value (an id-valued picker's selected item name). */
export function AutoSuggestHint({
  field,
  result,
  currentLabel,
}: {
  field: string;
  result: UseAutoFieldSuggestionResult;
  currentLabel?: string;
}) {
  const context = useFieldSuggestionContext();
  return (
    <FieldSuggestionHint
      currentLabel={currentLabel ?? result.currentLabel}
      currentValue={result.currentValue}
      questionKey={result.questionKey}
      suggestion={result.suggestion}
      applied={result.applied}
      pending={result.isPending}
      onApply={result.apply}
      alternative={context?.isAlternative(field) ?? false}
      outcome={context?.outcomeFor(field) ?? null}
      autoFilled={context?.isAutoFilled(field) ?? false}
      surface="line"
    />
  );
}
