import type { LocationTypeSuggestion } from "@cubby/schemas/ai";
import type {
  FieldPathByValue,
  FieldValues,
  UseFormReturn,
} from "react-hook-form";

import { ai } from "~/lib/ai.functions";

import { ProposedValue } from "../ai/ai-proposal-card";
import { FieldWithAISuggest } from "../ai/ai-suggest";
import { SelectField } from "../form-utils";
import { locationTypeOptionsWithTheme } from "./location-icons";

interface TypeFieldWithAIProps<TFieldValues extends FieldValues = FieldValues> {
  form: UseFormReturn<TFieldValues>;
  name: FieldPathByValue<TFieldValues, string | null | undefined>;
  locationName: string;
  disabled?: boolean;
  description?: string;
}

export function TypeFieldWithAI<
  TFieldValues extends FieldValues = FieldValues,
>({
  form,
  name,
  locationName,
  disabled = false,
  description,
}: TypeFieldWithAIProps<TFieldValues>) {
  const enabled = !!locationName.trim();

  return (
    <FieldWithAISuggest<LocationTypeSuggestion>
      field={
        <SelectField
          form={form}
          name={name}
          label="Type"
          options={locationTypeOptionsWithTheme}
          placeholder="Select a location type"
          disabled={disabled}
          description={description}
        />
      }
      enabled={enabled}
      disabledReason="Enter location name first"
      object="type"
      basisKey={locationName}
      currentValue={form.watch(name)}
      fieldDirty={form.getFieldState(name).isDirty}
      runSuggest={() => ai.suggestLocationType.call({ locationName })}
      onAccept={(r) => {
        // SAFETY: `name` is constrained to a string-valued field; React Hook
        // Form cannot carry that value constraint through its generic setter.
        form.setValue(name, r.type as TFieldValues[typeof name]);
      }}
    >
      {(r) => (
        <ProposedValue
          label="Type"
          value={
            locationTypeOptionsWithTheme.find(
              (option) => option.value === r.type,
            )?.label ?? r.type
          }
        />
      )}
    </FieldWithAISuggest>
  );
}
