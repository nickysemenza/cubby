import type { LocationTypeSuggestion } from "@cubby/schemas/ai";
import type { FieldValues, Path, UseFormReturn } from "react-hook-form";
import { useTRPCClient } from "~/integrations/trpc/react";
import { FieldWithAISuggest } from "../ai/ai-suggest";
import { SelectField } from "../form-utils";
import { locationTypeOptionsWithTheme } from "./location-icons";

interface TypeFieldWithAIProps<TFieldValues extends FieldValues = FieldValues> {
  form: UseFormReturn<TFieldValues>;
  name: Path<TFieldValues>;
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
  const trpcClient = useTRPCClient();
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
      suggestLabel="Use AI to suggest type"
      basisKey={locationName}
      currentValue={form.watch(name)}
      fieldDirty={form.getFieldState(name).isDirty}
      runSuggest={() =>
        trpcClient.ai.suggestLocationType.query({ locationName })
      }
      onAccept={(r) => form.setValue(name, r.type as TFieldValues[typeof name])}
    />
  );
}
