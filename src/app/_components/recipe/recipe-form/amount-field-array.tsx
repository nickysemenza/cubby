import { type FC } from "react";
import { useFieldArray, UseFormReturn } from "react-hook-form";
import { Button } from "~/components/ui/button";
import { Plus, Trash } from "lucide-react";
import {
  SideBySideFields,
  NumericField,
  RequiredTextField,
  createAmountObject,
  NullableNumberField,
} from "../../form-utils";
import { type RecipeFormValues } from "./types";

interface AmountFieldArrayProps {
  form: UseFormReturn<RecipeFormValues>;
  sectionIndex: number;
  ingredientIndex: number;
}

export const AmountFieldArray: FC<AmountFieldArrayProps> = ({
  form,
  sectionIndex,
  ingredientIndex,
}) => {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: `sections.${sectionIndex}.ingredients.${ingredientIndex}.amounts`,
  });

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => append(createAmountObject({ value: 1, unit: "" }))}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Amount
        </Button>
      </div>

      {fields.map((field, amountIndex) => (
        <div key={field.id} className="flex items-center space-x-2">
          <SideBySideFields>
            <NullableNumberField
              form={form}
              name={`sections.${sectionIndex}.ingredients.${ingredientIndex}.amounts.${amountIndex}.value`}
              label="Value"
              placeholder="Enter amount"
            />
            <RequiredTextField
              form={form}
              name={`sections.${sectionIndex}.ingredients.${ingredientIndex}.amounts.${amountIndex}.unit`}
              label="Unit"
              placeholder="Enter unit"
            />
          </SideBySideFields>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => remove(amountIndex)}
            disabled={fields.length <= 1}
            className="mt-6"
          >
            <Trash className="h-4 w-4" />
          </Button>
        </div>
      ))}
    </div>
  );
};
