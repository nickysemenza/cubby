import { type FC } from "react";
import { useFieldArray, UseFormReturn } from "react-hook-form";
import { Button } from "~/components/ui/button";
import { Plus, Trash, ChevronDown, ChevronUp } from "lucide-react";
import { WithIngredientSearch } from "../../combobox/with-search-hook";
import { ComboboxField } from "../../form-utils";
import { type RecipeFormValues } from "./types";
import { AmountFieldArray } from "./amount-field-array";

interface IngredientFieldArrayProps {
  form: UseFormReturn<RecipeFormValues>;
  sectionIndex: number;
}

export const IngredientFieldArray: FC<IngredientFieldArrayProps> = ({
  form,
  sectionIndex,
}) => {
  const { fields, append, remove, move } = useFieldArray({
    control: form.control,
    name: `sections.${sectionIndex}.ingredients`,
  });

  return (
    <div className="w-full space-y-2">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            append({
              type: "ingredient",
              ingredient: null,
              amounts: [{ value: 1, unit: "" }],
            })
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Ingredient
        </Button>
      </div>

      {fields.length === 0 ? (
        <div className="text-sm text-gray-500 italic">
          No ingredients added yet
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((field, ingredientIndex) => (
            <div
              key={field.id}
              className="border-opacity-50 space-y-2 rounded border border-gray-100 px-2 py-2"
            >
              <div className="flex items-center justify-between">
                <h6 className="text-sm font-medium">
                  Ingredient {ingredientIndex + 1}
                </h6>
                <div className="flex space-x-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      move(ingredientIndex, Math.max(0, ingredientIndex - 1))
                    }
                    disabled={ingredientIndex === 0}
                  >
                    <ChevronUp className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      move(
                        ingredientIndex,
                        Math.min(fields.length - 1, ingredientIndex + 1),
                      )
                    }
                    disabled={ingredientIndex === fields.length - 1}
                  >
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => remove(ingredientIndex)}
                  >
                    <Trash className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-row">
                <div className="w-1/2 pr-2">
                  <WithIngredientSearch>
                    {({ findItems, onCreateNew }) => (
                      <ComboboxField
                        form={form}
                        name={`sections.${sectionIndex}.ingredients.${ingredientIndex}.ingredient`}
                        label="Ingredient"
                        findItems={findItems}
                        onCreateNew={onCreateNew}
                      />
                    )}
                  </WithIngredientSearch>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Amounts</label>
                  <AmountFieldArray
                    form={form}
                    sectionIndex={sectionIndex}
                    ingredientIndex={ingredientIndex}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
