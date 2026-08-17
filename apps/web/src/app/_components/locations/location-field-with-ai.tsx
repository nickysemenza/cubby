import type { LocationSuggestion } from "@cubby/schemas/ai";
import type { ProductShortcode } from "@cubby/schemas/identifiers";
import type {
  FieldValues,
  Path,
  PathValue,
  UseFormReturn,
} from "react-hook-form";
import { useTRPCClient } from "~/integrations/trpc/react";
import { FieldWithAISuggest } from "../ai/ai-suggest";
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
 * returns its name, which is exactly the `{id, name}` a ComboboxItem is.
 */
export function LocationFieldWithAI<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  productId,
  label = "Location",
}: LocationFieldWithAIProps<TFieldValues>) {
  const trpcClient = useTRPCClient();

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
      runSuggest={() => trpcClient.ai.suggestLocation.query({ productId })}
      onResult={(r) =>
        form.setValue(
          name,
          { id: r.location.id, name: r.location.name } as PathValue<
            TFieldValues,
            Path<TFieldValues>
          >,
          { shouldValidate: true },
        )
      }
    />
  );
}
