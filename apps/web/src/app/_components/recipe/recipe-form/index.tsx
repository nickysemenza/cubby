import { unsafeRecipeId } from "@cubby/schemas/identifiers";
import type {
  RecipeCreateInput,
  RecipeIngredientInput,
  RecipeUpdateInput,
  recipeInstructionInput,
  recipeSectionInput,
} from "@cubby/schemas/recipe";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Import, Plus, Trash } from "lucide-react";
import { type FC, useId, useMemo, useState } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import type { z } from "zod";
import {
  getOptionalIngredientId,
  getOptionalRecipeId,
} from "~/app/_components/form-fields";
import { Button } from "~/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Field, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import useDebounce from "~/hooks/useDebounce";
import { useImageState } from "~/hooks/useImageState";
import { wasm } from "~/lib/wasm";
import { useTRPC } from "~/trpc/react";
import {
  buildUpdateObject,
  FormWrapper,
  getSubmitButtonText,
  NullableNumericField,
  SideBySideFields,
  UnifiedTextField,
} from "../../form-utils";
import { PendingImageUpload } from "../../PendingImageUpload";
import { formatRichText } from "../richtext";
import { IngredientFieldArray } from "./ingredient-field-array";
import {
  IngredientPreviewTable,
  useIngredientImport,
} from "./ingredient-preview-table";
import { InstructionFieldArray } from "./instruction-field-array";
import { TagInput } from "./tag-input";
import {
  formSchema,
  type IngItem,
  type RecipeFormProps,
  type RecipeFormValues,
} from "./types";
import { haveIngredientsChanged, haveInstructionsChanged } from "./utils";

// Yield and Servings fields with smart hide behavior
const YieldServingsFields: FC<{
  form: ReturnType<typeof useForm<RecipeFormValues>>;
}> = ({ form }) => {
  const yieldUnitId = useId();
  const yieldUnit = useWatch({ control: form.control, name: "yield.unit" });

  // Show servings field if yield unit is set and not "servings"
  const showServings = yieldUnit && yieldUnit !== "servings";

  return (
    <div className="space-y-4">
      <SideBySideFields>
        <NullableNumericField
          form={form}
          name="yield.value"
          label="Yield Value (Optional)"
          placeholder="e.g., 24"
        />
        <Controller
          control={form.control}
          name="yield.unit"
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor={yieldUnitId}>Yield Unit</FieldLabel>
              <Input
                id={yieldUnitId}
                placeholder="e.g., cookies, servings, cups"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value || null)}
              />
            </Field>
          )}
        />
      </SideBySideFields>

      {showServings && (
        <NullableNumericField
          form={form}
          name="servings"
          label="Servings"
          placeholder="How many portions?"
        />
      )}
    </div>
  );
};

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
  const api = useTRPC();
  const {
    handlePendingImagesChange,
    handleRemovedImagesChange,
    getImageData,
    hasImageChanges,
  } = useImageState();

  // Import section state
  const [textImportOpen, setTextImportOpen] = useState(false);
  const [textImportIngredients, setTextImportIngredients] = useState("");
  const [textImportInstructions, setTextImportInstructions] = useState("");

  // Debounced ingredient lines for live preview
  const debouncedIngredients = useDebounce(textImportIngredients, 200);
  const ingredientLines = useMemo(
    () =>
      debouncedIngredients
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    [debouncedIngredients],
  );

  // Instruction lines for preview
  const debouncedInstructions = useDebounce(textImportInstructions, 200);
  const instructionLines = useMemo(
    () =>
      debouncedInstructions
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    [debouncedInstructions],
  );

  // Hook for importing ingredients with auto-create
  const ingredientImport = useIngredientImport(ingredientLines);

  // Parse instructions with rich text highlighting
  // Uses namesForHighlighting which includes parsed names + matched DB names + aliases
  const richInstructions = useMemo(
    () =>
      instructionLines.map((line) => {
        try {
          return wasm.parse_rich_text(
            line,
            ingredientImport.namesForHighlighting,
          );
        } catch {
          // Fallback to plain text if parsing fails
          return [{ kind: "Text" as const, value: line }];
        }
      }),
    [instructionLines, ingredientImport.namesForHighlighting],
  );

  // Scrape mutation
  const scrapeMutation = useMutation(api.recipe.scrape.mutationOptions());

  // Get the recipe entity in edit mode
  const recipe = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;

  // Initialize form with default values or existing recipe data
  const form = useForm<RecipeFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: recipe ? recipe.name : (initialName ?? ""),
      meta: recipe ? recipe.meta : null,
      yield: recipe?.yield ?? null,
      servings: recipe?.servings ?? null,
      tags: recipe?.tags ?? [],
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

  // Watch URL field for scrape button
  const urlValue = useWatch({ control: form.control, name: "meta.url" });

  // Handle URL scraping - opens collapsible and populates textareas
  const handleScrape = async () => {
    if (!urlValue) return;
    try {
      const result = await scrapeMutation.mutateAsync(urlValue);
      if (result?.sections[0]) {
        // Set recipe name if empty
        if (!form.getValues("name")) {
          form.setValue("name", result.name);
        }
        // Populate textareas and open collapsible
        setTextImportIngredients(result.sections[0].ingredients.join("\n"));
        setTextImportInstructions(result.sections[0].instructions.join("\n"));
        setTextImportOpen(true);

        // Set servings if available from scraper
        if (result.servings) {
          form.setValue("servings", result.servings);
        }

        // Set yield if available from scraper (already parsed by Rust)
        if (result.recipe_yield) {
          form.setValue("yield", {
            value: result.recipe_yield.value,
            unit: result.recipe_yield.unit,
          });
        }
      }
    } catch {
      // Error handled by mutation
    }
  };

  // Handle import - auto-creates missing ingredients and populates form
  const handleImportAll = async () => {
    try {
      // Import all ingredients (auto-creates missing ones)
      const structuredIngredients = await ingredientImport.importAll();

      // Build structured instructions
      const structuredInstructions = instructionLines.map((inst) => ({
        instruction: inst,
      }));

      // Populate form
      const currentSections = form.getValues("sections");
      if (currentSections.length > 0) {
        form.setValue("sections.0.ingredients", structuredIngredients);
        form.setValue("sections.0.instructions", structuredInstructions);
      } else {
        form.setValue("sections", [
          {
            name: null,
            ingredients: structuredIngredients,
            instructions: structuredInstructions,
          },
        ]);
      }

      // Clear and close import section
      setTextImportIngredients("");
      setTextImportInstructions("");
      setTextImportOpen(false);
    } catch (error) {
      console.error("Import failed:", error);
    }
  };

  const handleSubmit = (values: RecipeFormValues) => {
    if (mode === "create") {
      // For creation, transform the form values to the API format
      const createData: RecipeCreateInput = {
        name: values.name,
        meta: values.meta,
        yield: values.yield,
        servings: values.servings,
        tags: values.tags,
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
      const basicUpdates = buildUpdateObject(recipe, values, [
        "name",
        "meta",
        "yield",
        "servings",
        "tags",
      ]);

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
          id: unsafeRecipeId(recipe.id),
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

  const buttonText = getSubmitButtonText(mode);

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

        <Field>
          <FieldLabel>URL (Optional)</FieldLabel>
          <div className="flex gap-2">
            <Controller
              control={form.control}
              name="meta.url"
              render={({ field }) => (
                <Input
                  placeholder="Enter recipe URL"
                  value={field.value ?? ""}
                  onChange={(e) => field.onChange(e.target.value || null)}
                  className="flex-1"
                />
              )}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleScrape}
              disabled={!urlValue || scrapeMutation.isPending}
              className="shrink-0"
            >
              {scrapeMutation.isPending ? (
                <Spinner className="mr-1" />
              ) : (
                <Import className="mr-1 h-4 w-4" />
              )}
              Scrape
            </Button>
          </div>
        </Field>
      </SideBySideFields>

      {/* Import from Text */}
      <Collapsible open={textImportOpen} onOpenChange={setTextImportOpen}>
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="flex items-center gap-1 text-muted-foreground"
            />
          }
        >
          {textImportOpen ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
          Import from Text
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-4 rounded border border-border p-3">
          {/* Ingredients: textarea + pills preview */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field>
              <FieldLabel>Ingredients (one per line)</FieldLabel>
              <Textarea
                placeholder="1 cup flour&#10;2 eggs&#10;1/2 tsp salt"
                value={textImportIngredients}
                onChange={(e) => setTextImportIngredients(e.target.value)}
                rows={6}
              />
            </Field>
            <div>
              <FieldLabel>Parsed Ingredients</FieldLabel>
              <div className="mt-1.5 min-h-[120px] rounded border border-border bg-muted/30 p-2">
                <IngredientPreviewTable ingredientLines={ingredientLines} />
              </div>
            </div>
          </div>

          {/* Instructions: textarea + preview */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Field>
              <FieldLabel>Instructions (one per line)</FieldLabel>
              <Textarea
                placeholder="Preheat oven to 350°F&#10;Mix dry ingredients&#10;Add wet ingredients"
                value={textImportInstructions}
                onChange={(e) => setTextImportInstructions(e.target.value)}
                rows={6}
              />
            </Field>
            <div>
              <FieldLabel>Instructions Preview</FieldLabel>
              <div className="mt-1.5 min-h-[120px] rounded border border-border bg-muted/30 p-2">
                {richInstructions.length > 0 ? (
                  <ol className="list-decimal space-y-1.5 pl-4 text-sm">
                    {richInstructions.map((richItems, idx) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: instructions are ordered by line
                      <li key={idx}>{formatRichText(richItems)}</li>
                    ))}
                  </ol>
                ) : (
                  <div className="text-muted-foreground text-sm">
                    Enter instructions to see preview
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Import button */}
          <div className="flex items-center justify-between">
            <div className="text-muted-foreground text-sm">
              {ingredientImport.totalCount > 0 && (
                <>
                  {ingredientImport.matchedCount}/{ingredientImport.totalCount}{" "}
                  ingredients matched
                  {ingredientImport.missingCount > 0 && (
                    <span className="text-amber-600">
                      {" "}
                      ({ingredientImport.missingCount} will be created)
                    </span>
                  )}
                </>
              )}
            </div>
            <Button
              type="button"
              variant="default"
              size="sm"
              onClick={handleImportAll}
              disabled={
                ingredientImport.isLoading ||
                ingredientImport.isImporting ||
                (ingredientLines.length === 0 && instructionLines.length === 0)
              }
            >
              {ingredientImport.isImporting ? (
                <Spinner className="mr-1" />
              ) : (
                <Import className="mr-1 h-4 w-4" />
              )}
              {ingredientImport.missingCount > 0
                ? `Import All (create ${ingredientImport.missingCount})`
                : "Import All"}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {/* Yield and Servings */}
      <YieldServingsFields form={form} />

      {/* Tags */}
      <Controller
        control={form.control}
        name="tags"
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor="tags">Tags (Optional)</FieldLabel>
            <TagInput value={field.value} onChange={field.onChange} />
          </Field>
        )}
      />

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
