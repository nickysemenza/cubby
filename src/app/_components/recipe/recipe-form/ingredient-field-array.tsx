import { type FC } from "react";
import { useFieldArray, UseFormReturn } from "react-hook-form";
import { Button } from "~/components/ui/button";
import { Plus } from "lucide-react";
import { WithIngredientSearch } from "../../combobox/with-search-hook";
import { ComboboxField } from "../../form-utils";
import { type RecipeFormValues } from "./types";
import { AmountFieldArray } from "./amount-field-array";
import { FieldArrayItemControls } from "./field-array-item-controls";
import { IngredientPillLink } from "../../EntityPill";

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
              <div className="flex flex-row items-center">
                <div className="flex w-8 flex-col items-center justify-center">
                  <h6 className="rotate-[-90deg] text-sm font-medium whitespace-nowrap">
                    Ingredient #{ingredientIndex + 1}
                  </h6>
                </div>
                <div className="w-1/2 pr-2">
                  <WithIngredientSearch>
                    {({ findItems, onCreateNew }) => (
                      <>
                        <ComboboxField
                          form={form}
                          name={`sections.${sectionIndex}.ingredients.${ingredientIndex}.ingredient`}
                          label="Ingredient"
                          findItems={findItems}
                          onCreateNew={onCreateNew}
                        />
                        {form.watch(
                          `sections.${sectionIndex}.ingredients.${ingredientIndex}.ingredient`,
                        ) && (
                          <div className="mt-1">
                            <IngredientPillLink
                              id={form.watch(
                                `sections.${sectionIndex}.ingredients.${ingredientIndex}.ingredient.id`,
                              )}
                              name={form.watch(
                                `sections.${sectionIndex}.ingredients.${ingredientIndex}.ingredient.name`,
                              )}
                              openInNewTab={true}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </WithIngredientSearch>
                </div>

                <div className="space-y-2">
                  {/* <label className="text-sm font-medium">Amounts</label> */}
                  <AmountFieldArray
                    form={form}
                    sectionIndex={sectionIndex}
                    ingredientIndex={ingredientIndex}
                  />
                </div>
                <FieldArrayItemControls
                  move={move}
                  remove={remove}
                  index={ingredientIndex}
                  fieldsLength={fields.length}
                  className="ml-4 flex flex-col space-y-1"
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex justify-end">
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
    </div>
  );
};
