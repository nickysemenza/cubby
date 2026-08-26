import type { LocationSuggestion } from "@cubby/schemas/ai";
import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type {
  FieldValues,
  Path,
  PathValue,
  UseFormReturn,
} from "react-hook-form";
import { ai } from "~/lib/ai.functions";
import { FieldWithAISuggest } from "../ai/ai-suggest";
import { buildLocationComboboxItem } from "../combobox/combobox-builders";
import { ComboboxFieldWithSearch } from "../form-utils/combobox-field-with-search";

interface LocationFieldWithAIProps<
  TFieldValues extends FieldValues = FieldValues,
> {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
  /** The product being put away — the whole basis of the suggestion. */
  productId: ProductShortcode;
  label?: string;
}

/**
 * A location combobox with a Suggest button, for "where does this go?".
 *
 * `FieldWithAISuggest` takes its field as a node, so the combobox goes in
 * untouched — the same shape as `TypeFieldWithAI` even though that one wraps a
 * SelectField. The server resolves the model's answer to a real location and
 * returns the row's full identity, which goes through the picker's own
 * `buildLocationComboboxItem`: an accepted suggestion has to render with its
 * ancestor breadcrumb like every other pick, or it reads as an ambiguous name.
 */
export function LocationFieldWithAI<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  productId,
  label = "Location",
}: LocationFieldWithAIProps<TFieldValues>) {
  return (
    <FieldWithAISuggest<LocationSuggestion>
      field={
        <ComboboxFieldWithSearch
          form={form}
          name={name}
          label={label}
          searchType="location"
        />
      }
      enabled
      disabledReason=""
      suggestLabel="Use AI to suggest a location"
      basisKey={productId}
      currentValue={form.watch(name)}
      fieldDirty={form.getFieldState(name).isDirty}
      runSuggest={() => ai.suggestLocation.call({ productId })}
      onAccept={(r) =>
        form.setValue(
          name,
          buildLocationComboboxItem(r.location) as PathValue<
            TFieldValues,
            Path<TFieldValues>
          >,
          { shouldValidate: true },
        )
      }
    />
  );
}
