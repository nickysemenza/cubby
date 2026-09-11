import type { LocationSuggestion } from "@cubby/schemas/ai";
import type {
  LocationShortcode,
  ProductShortcode,
} from "@cubby/schemas/identifiers";
import type {
  FieldPathByValue,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";

import { ai } from "~/lib/ai.functions";

import { ProposedValue } from "../ai/ai-proposal-card";
import { FieldWithAISuggest } from "../ai/ai-suggest";
import { buildLocationComboboxItem } from "../combobox/combobox-builders";
import type { ComboboxItem } from "../combobox/combobox-types";
import { ComboboxFieldWithSearch } from "../form-utils/combobox-field-with-search";

export interface LocationFieldWithAIOperations {
  suggestLocation: typeof ai.suggestLocation;
}

const productionLocationFieldWithAIOperations: LocationFieldWithAIOperations = {
  suggestLocation: ai.suggestLocation,
};

interface LocationFieldWithAIProps<
  TFieldValues extends FieldValues,
  TName extends FieldPathByValue<TFieldValues, ComboboxItem | null | undefined>,
> {
  form: UseFormReturn<TFieldValues>;
  name: TName;
  /** The product being put away — the whole basis of the suggestion. */
  productId: ProductShortcode;
  label?: string;
  operations?: LocationFieldWithAIOperations;
  /** The owning form supplies the correlated field write. */
  acceptLocation: (location: ComboboxItem<LocationShortcode>) => void;
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
  TFieldValues extends FieldValues,
  TName extends FieldPathByValue<TFieldValues, ComboboxItem | null | undefined>,
>({
  form,
  name,
  productId,
  label = "Location",
  operations = productionLocationFieldWithAIOperations,
  acceptLocation,
}: LocationFieldWithAIProps<TFieldValues, TName>) {
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
      object="a location"
      basisKey={productId}
      currentValue={form.watch(name)}
      fieldDirty={form.getFieldState(name).isDirty}
      runSuggest={() => operations.suggestLocation.call({ productId })}
      onAccept={(result) =>
        acceptLocation(buildLocationComboboxItem(result.location))
      }
    >
      {(result) => (
        <ProposedValue label="Location" value={result.location.name} />
      )}
    </FieldWithAISuggest>
  );
}
