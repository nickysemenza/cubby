import { zodResolver } from "@hookform/resolvers/zod";
import { ChevronDown, ChevronUp, Plus, Trash } from "lucide-react";
import type { FC } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import type { z } from "zod";
import { Button } from "~/components/ui/button";
import { useImageState } from "~/hooks/useImageState";
import {
  getOptionalIngredientId,
  getOptionalRecipeId,
} from "~/schemas/form-fields";
import type { RecipeId } from "~/schemas/identifiers";
import type {
  RecipeCreateInput,
  RecipeIngredientInput,
  RecipeUpdateInput,
  recipeInstructionInput,
  recipeSectionInput,
} from "~/schemas/recipe";
import {
  buildUpdateObject,
  FormWrapper,
  getSubmitButtonText,
  SideBySideFields,
  UnifiedTextField,
} from "../../form-utils";
import { PendingImageUpload } from "../../PendingImageUpload";
import { IngredientFieldArray } from "./ingredient-field-array";
import { InstructionFieldArray } from "./instruction-field-array";
import {
  formSchema,
  type IngItem,
  type RecipeFormProps,
  type RecipeFormValues,
} from "./types";
import { haveIngredientsChanged, haveInstructionsChanged } from "./utils";

// Helper function to map any ingredient type to the correct API format
const mapIngredientToApiFormat = (ing: IngItem): RecipeIngredientInput => {
  if (ing.type === "ingredient" && ing.ingredient) {
    return {
      type: "ingredient",
      ingredientId: getOptionalIngredientId(ing.ingredient)!,
      recipeId: null,
      amounts: ing.amounts,
      id: ing.id,
    };
  } else if (ing.type === "recipe" && ing.recipe) {
    return {
      type: "recipe",
      recipeId: getOptionalRecipeId(ing.recipe)!,
      ingredientId: null,
      amounts: ing.amounts,
      id: ing.id,
    };
  }
  throw new Error(
    `Invalid ingredient type or missing data: ${JSON.stringify(ing)}`,
  );
};

export const RecipeForm: FC<RecipeFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;
  const {
    handlePendingImagesChange,
    handleRemovedImagesChange,
    getImageData,
    hasImageChanges,
  } = useImageState();

  // Get the recipe entity in edit mode
  const recipe = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;

  // Initialize form with default values or existing recipe data
  const form = useForm<RecipeFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: recipe ? recipe.name : (initialName ?? ""),
      meta: recipe ? recipe.meta : null,
      sections: recipe
        ? recipe.sections.map((section) => ({
            id: section.id,
            name: section.name,
            ingredients: section.ingredients.map((ing) => {
              if (ing.type === "ingredient") {
                return {
                  id: ing.id,
                  type: "ingredient" as const,
                  ingredient: {
                    id: ing.ingredient.id,
                    name: ing.ingredient.name,
                  },
                  recipe: null,
                  amounts: ing.amounts,
                };
              } else {
                return {
                  id: ing.id,
                  type: "recipe" as const,
                  ingredient: null,
                  recipe: {
                    id: ing.recipe.id,
                    name: ing.recipe.name,
                  },
                  amounts: ing.amounts,
                };
              }
            }),
            instructions: section.instructions,
          }))
        : [
            {
              name: null,
              ingredients: [],
              instructions: [],
            },
          ],
    },
  });

  // Set up field arrays for sections
  const {
    fields: sectionFields,
    append: appendSection,
    remove: removeSection,
    move: moveSection,
  } = useFieldArray({
    control: form.control,
    name: "sections",
  });

  const handleSubmit = (values: RecipeFormValues) => {
    if (mode === "create") {
      // For creation, transform the form values to the API format
      const createData: RecipeCreateInput = {
        name: values.name,
        meta: values.meta,
        sections: values.sections.map((section) => ({
          name: section.name,
          ingredients: section.ingredients.map(mapIngredientToApiFormat),
          instructions: section.instructions,
        })),
        ...getImageData(true), // Apply pending images for creation
      };

      props.onCreate(createData);
    } else if (mode === "edit" && recipe) {
      // In edit mode, determine which fields have changed
      const basicUpdates = buildUpdateObject(recipe, values, ["name", "meta"]);

      // Handle section updates - this is more complex since we need to track IDs
      const sectionUpdates = values.sections.map((section, idx) => {
        const originalSection = recipe.sections[idx];

        // For a new section or completely changed section
        if (!originalSection || !section.id) {
          return {
            name: section.name,
            ingredients: section.ingredients.map(mapIngredientToApiFormat),
            instructions: section.instructions,
          };
        }

        // For existing section, include ID and track changes
        const sectionUpdate: z.infer<typeof recipeSectionInput> = {
          id: section.id,
        };

        // Check for name changes
        if (originalSection.name !== section.name) {
          sectionUpdate.name = section.name;
        }

        // Check for ingredient changes
        const ingredientsChanged = haveIngredientsChanged(
          originalSection.ingredients,
          section.ingredients,
        );

        if (ingredientsChanged) {
          sectionUpdate.ingredients = section.ingredients.map(
            mapIngredientToApiFormat,
          );
        }

        // Check for instruction changes
        const instructionsChanged = haveInstructionsChanged(
          originalSection.instructions,
          section.instructions,
        );

        if (instructionsChanged) {
          sectionUpdate.instructions = section.instructions.map((inst) => {
            const output: z.infer<typeof recipeInstructionInput> = {
              instruction: inst.instruction,
            };

            // Include ID if it exists (for updates)
            if (inst.id) {
              output.id = inst.id;
            }

            return output;
          });
        }

        return sectionUpdate;
      });

      // Check if we have any changes
      const imageChanges = hasImageChanges();
      const hasFieldChanges =
        Object.keys(basicUpdates).length > 0 ||
        sectionUpdates.some((s) => Object.keys(s).length > 1);

      // Only update if there are changes
      if (hasFieldChanges || imageChanges) {
        const updateData: RecipeUpdateInput = {
          id: recipe.id as RecipeId,
          data: {
            ...basicUpdates,
            sections: sectionUpdates,
            ...getImageData(), // Apply image updates
          },
        };
        props.onEdit(updateData);
      } else if (onCancel) {
        // If no changes, just run the cancel function
        onCancel();
      }
    }
  };

  const buttonText = getSubmitButtonText(mode, isPending);

  return (
    <FormWrapper
      form={form}
      onSubmit={handleSubmit}
      error={error}
      isPending={isPending}
      onCancel={onCancel}
      submitButtonText={buttonText}
    >
      <SideBySideFields>
        <UnifiedTextField
          form={form}
          name="name"
          label="Name"
          placeholder="Enter recipe name"
          nullable={false}
        />

        <UnifiedTextField
          form={form}
          name="meta.url"
          label="URL (Optional)"
          placeholder="Enter recipe URL"
          nullable={true}
        />
      </SideBySideFields>

      {/* Show image upload in both create and edit modes */}
      <PendingImageUpload
        entityType="RECIPE"
        onImagesChange={handlePendingImagesChange}
        existingImages={mode === "edit" && recipe?.images ? recipe.images : []}
        onExistingImagesRemove={handleRemovedImagesChange}
        className="mt-4"
      />

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-medium text-lg">Recipe Sections</h3>
        </div>

        {sectionFields.map((sectionField, sectionIndex) => (
          <div
            key={sectionField.id}
            className="space-y-3 rounded border border-border p-3"
          >
            <div className="flex items-center justify-between">
              <h4 className="font-medium">
                Section {sectionIndex + 1}
                {sectionField.name ? `: ${sectionField.name}` : ""}
              </h4>
              <div className="flex space-x-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    moveSection(sectionIndex, Math.max(0, sectionIndex - 1))
                  }
                  disabled={sectionIndex === 0}
                >
                  <ChevronUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() =>
                    moveSection(
                      sectionIndex,
                      Math.min(sectionFields.length - 1, sectionIndex + 1),
                    )
                  }
                  disabled={sectionIndex === sectionFields.length - 1}
                >
                  <ChevronDown className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeSection(sectionIndex)}
                  disabled={sectionFields.length === 1}
                >
                  <Trash className="h-4 w-4" />
                </Button>
              </div>
            </div>

            {/* Ingredients and Instructions side by side */}
            <div className="flex flex-col space-y-3 md:flex-row md:space-x-3 md:space-y-0">
              {/* Ingredients */}
              <div className="md:w-1/2">
                <h5 className="mb-2 font-medium text-sm">Ingredients</h5>
                <IngredientFieldArray form={form} sectionIndex={sectionIndex} />
              </div>

              {/* Instructions */}
              <div className="md:w-1/2">
                <UnifiedTextField
                  form={form}
                  name={`sections.${sectionIndex}.name`}
                  label="Section Name (Optional)"
                  placeholder="E.g., 'Main Course', 'Sauce', etc."
                  nullable={true}
                />
                <h5 className="mb-2 font-medium text-sm">Instructions</h5>
                <InstructionFieldArray
                  form={form}
                  sectionIndex={sectionIndex}
                />
              </div>
            </div>
          </div>
        ))}

        <div className="mt-3 flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              appendSection({
                name: null,
                ingredients: [],
                instructions: [],
              })
            }
          >
            <Plus className="mr-2 h-4 w-4" />
            Add Section
          </Button>
        </div>
      </div>
    </FormWrapper>
  );
};
