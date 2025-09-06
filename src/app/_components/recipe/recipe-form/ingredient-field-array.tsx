import { type FC } from "react";
import { useFieldArray, UseFormReturn } from "react-hook-form";
import { Button } from "~/components/ui/button";
import { Plus } from "lucide-react";
import {
  WithIngredientSearch,
  WithRecipeSearch,
} from "../../combobox/with-search-hook";
import { ComboboxField } from "../../form-utils";
import { type RecipeFormValues } from "./types";
import { AmountFieldArray } from "./amount-field-array";
import { FieldArrayItemControls } from "./field-array-item-controls";
import { IngredientPillLink, RecipePillLink } from "../../EntityPill";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { sectionIngredientType } from "~/schemas/recipe";

interface IngredientFieldArrayProps {
  form: UseFormReturn<RecipeFormValues>;
  sectionIndex: number;
}

export const IngredientFieldArray: FC<IngredientFieldArrayProps> = ({
  form,
  sectionIndex,
}) => {
  const { fields, append, remove, move, update } = useFieldArray({
    control: form.control,
    name: `sections.${sectionIndex}.ingredients`,
  });

  return (
    <div className="w-full space-y-2">
      {fields.length === 0 ? (
        <div className="text-muted-foreground text-sm italic">
          No ingredients added yet
        </div>
      ) : (
        <div className="space-y-2">
          {fields.map((field, ingredientIndex) => (
            <div
              key={field.id}
              className="border-opacity-50 border-border space-y-2 rounded border px-2 py-2"
            >
              <div className="flex flex-row items-center">
                <div className="flex w-8 flex-col items-center justify-center">
                  <h6 className="rotate-[-90deg] text-sm font-medium whitespace-nowrap">
                    Ingredient #{ingredientIndex + 1}
                  </h6>
                </div>
                <div className="w-1/2 pr-2">
                  <Tabs
                    defaultValue={form.watch(
                      `sections.${sectionIndex}.ingredients.${ingredientIndex}.type`,
                    )}
                    onValueChange={(value) => {
                      const currentField = form.getValues(
                        `sections.${sectionIndex}.ingredients.${ingredientIndex}`,
                      );
                      const newType = value as sectionIngredientType;

                      // Update the field with the new type and reset the corresponding values
                      if (newType === "ingredient") {
                        update(ingredientIndex, {
                          ...currentField,
                          type: newType,
                          ingredient: { id: "", name: "" }, // Empty ComboboxItem
                          recipe: null,
                        });
                      } else {
                        update(ingredientIndex, {
                          ...currentField,
                          type: newType,
                          ingredient: null,
                          recipe: { id: "", name: "" }, // Empty ComboboxItem
                        });
                      }
                    }}
                    className="w-full"
                  >
                    <TabsList className="mb-2">
                      <TabsTrigger value="ingredient">Ingredient</TabsTrigger>
                      <TabsTrigger value="recipe">Recipe</TabsTrigger>
                    </TabsList>

                    <TabsContent value="ingredient">
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
                    </TabsContent>

                    <TabsContent value="recipe">
                      <WithRecipeSearch>
                        {({ findItems }) => (
                          <>
                            <ComboboxField
                              form={form}
                              name={`sections.${sectionIndex}.ingredients.${ingredientIndex}.recipe`}
                              label="Recipe"
                              findItems={findItems}
                            />
                            {form.watch(
                              `sections.${sectionIndex}.ingredients.${ingredientIndex}.recipe`,
                            ) && (
                              <div className="mt-1">
                                <RecipePillLink
                                  recipe={{
                                    id: form.watch(
                                      `sections.${sectionIndex}.ingredients.${ingredientIndex}.recipe.id`,
                                    ),
                                    name: form.watch(
                                      `sections.${sectionIndex}.ingredients.${ingredientIndex}.recipe.name`,
                                    ),
                                  }}
                                  openInNewTab={true}
                                />
                              </div>
                            )}
                          </>
                        )}
                      </WithRecipeSearch>
                    </TabsContent>
                  </Tabs>
                </div>

                <div className="space-y-2">
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

      <div className="mt-2 flex justify-between">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            append({
              type: "ingredient",
              ingredient: { id: "", name: "" }, // Empty ComboboxItem
              recipe: null,
              amounts: [{ value: 1, unit: "" }],
            })
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Ingredient
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            append({
              type: "recipe",
              ingredient: null,
              recipe: { id: "", name: "" }, // Empty ComboboxItem
              amounts: [{ value: 1, unit: "" }],
            })
          }
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Recipe Reference
        </Button>
      </div>
    </div>
  );
};
