import { type FC } from "react";
import { useFieldArray, UseFormReturn } from "react-hook-form";
import { Button } from "~/components/ui/button";
import { Plus, Trash } from "lucide-react";
import {
  SideBySideFields,
  NullableNumericField,
  UnifiedTextField,
} from "../../form-utils";
import { type RecipeFormValues } from "./types";
import { useWasm } from "~/wasmContext";
import { getHoverableMeasureUnitIcon } from "../../inventory/format-amount";

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
  const { w } = useWasm();

  return (
    <div className="space-y-1">
      {fields.map((field, amountIndex) => (
        <div key={field.id} className="flex items-center space-x-1">
          <SideBySideFields>
            <NullableNumericField
              form={form}
              name={`sections.${sectionIndex}.ingredients.${ingredientIndex}.amounts.${amountIndex}.value`}
              label="Value"
              placeholder="Enter amount"
            />
            <UnifiedTextField
              form={form}
              name={`sections.${sectionIndex}.ingredients.${ingredientIndex}.amounts.${amountIndex}.unit`}
              label="Unit"
              placeholder="Enter unit"
              nullable={false}
              getIcon={(x) => w && x && getHoverableMeasureUnitIcon(w, x)}
            />
          </SideBySideFields>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => remove(amountIndex)}
            disabled={fields.length <= 1}
            className="mt-5"
          >
            <Trash className="h-4 w-4" />
          </Button>
          {amountIndex === fields.length - 1 ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => append({ value: 1, unit: "" })}
              className="mt-5"
            >
              <Plus className="h-4 w-4" />
            </Button>
          ) : (
            <div className="mt-5 w-9 flex-shrink-0" />
          )}
        </div>
      ))}
    </div>
  );
};
