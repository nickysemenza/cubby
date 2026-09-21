import type { FieldValues, Path, UseFormReturn } from "react-hook-form";

import { FieldSuggestionHint } from "./field-suggestion-hint";
import { useFieldSuggestionContext } from "./field-suggestion-provider";
import { FormFieldResolution } from "./form-field-resolution";
import { useAutoFieldSuggestion } from "./use-auto-field-suggestion";

/**
 * The `useAutoFieldSuggestion` + `FieldSuggestionHint` pairing every
 * suggest-enabled primitive (`SelectField`, `EntityValueField`,
 * `ComboboxFieldWithSearch`, `VendorField`) renders the same way. Mounted
 * only when the primitive's `suggestField` prop is set — no-op without a
 * `FieldSuggestionProvider` above it, same as the hook it wraps.
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
  const {
    suggestion,
    applied,
    isPending,
    apply,
    currentValue,
    currentLabel,
    questionKey,
  } = useAutoFieldSuggestion({
    form,
    name,
    field,
    valueKind,
    disabled,
  });
  return (
    <>
      <FormFieldResolution form={form} field={field} />
      <FieldSuggestionHint
        currentLabel={currentLabel}
        currentValue={currentValue}
        questionKey={questionKey}
        suggestion={suggestion}
        applied={applied}
        pending={isPending}
        onApply={apply}
        alternative={context?.isAlternative(field) ?? false}
      />
    </>
  );
}
