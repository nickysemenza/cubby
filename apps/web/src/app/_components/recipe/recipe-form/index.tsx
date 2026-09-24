import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import { zodResolver } from "@hookform/resolvers/zod";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretUpIcon } from "@phosphor-icons/react/dist/csr/CaretUp";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useMutation } from "@tanstack/react-query";
import { type FC, useEffect, useId, useMemo, useRef, useState } from "react";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { recipe as recipeOperations } from "~/app/recipes/recipe.functions";
import { showErrorToast } from "~/components/feedback/error-details";
import { Row, Stack } from "~/components/layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { EntityPrimitiveFields } from "~/entities/editing/entity-primitive-fields";
import { useImageState } from "~/hooks/useImageState";
import { getErrorMessage } from "~/lib/error-utils";
import { wasm } from "~/lib/wasm";

import {
  FormWrapper,
  getSubmitButtonText,
  UnifiedTextField,
} from "../../form-utils";
import { FormFieldGroup } from "../../forms/form-field-group";
import { PendingImageUpload } from "../../PendingImageUpload";
import { parseRichTextSafe } from "../richtext";
import {
  recipeFormValuesToCreateInput,
  recipeFormValuesToUpdateInput,
  recipeToFormValues,
} from "./adapters";
import { EditorTally, YieldServingsFields } from "./form-strips";
import { ImportToolsPanel } from "./import-tools-panel";
import { IngredientFieldArray } from "./ingredient-field-array";
import {
  useIngredientImport,
  useIngredientResolver,
} from "./ingredient-preview-table";
import { InstructionFieldArray } from "./instruction-field-array";
import { RecipeLivePreview } from "./recipe-live-preview";
import { TagInput } from "./tag-input";
import {
  formSchema,
  type RecipeFormProps,
  type RecipeFormValues,
} from "./types";

export const RecipeForm: FC<RecipeFormProps> = (props) => {
  const { mode, isPending, error, onCancel } = props;
  const tagsId = useId();
  const {
    handlePendingImagesChange,
    handleRemovedImagesChange,
    getImageData,
    hasImageChanges,
  } = useImageState();

  // Which import tool panel is open. They're plumbing, not recipe data, so
  // they collapse behind a toolbar; scraping starts open when creating fresh.
  const [openTool, setOpenTool] = useState<"scrape" | "text" | "html" | null>(
    mode === "create" ? "scrape" : null,
  );
  const toggleTool = (tool: "scrape" | "text" | "html") =>
    setOpenTool((current) => (current === tool ? null : tool));

  // Import section state
  const [textImportIngredients, setTextImportIngredients] = useState("");
  const [textImportInstructions, setTextImportInstructions] = useState("");
  // Pasted page HTML, for the parse-only fallback when a URL scrape is blocked.
  const [htmlInput, setHtmlInput] = useState("");

  // Debounced ingredient lines for live preview
  const [debouncedIngredients] = useDebouncedValue(textImportIngredients, {
    wait: 200,
  });
  const ingredientLines = useMemo(
    () =>
      debouncedIngredients
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    [debouncedIngredients],
  );

  // Instruction lines for preview
  const [debouncedInstructions] = useDebouncedValue(textImportInstructions, {
    wait: 200,
  });
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
      instructionLines.map((line) =>
        parseRichTextSafe(line, ingredientImport.namesForHighlighting),
      ),
    [instructionLines, ingredientImport.namesForHighlighting],
  );

  // Scrape mutation + parse-only fallback for pasted HTML
  const scrapeMutation = useMutation(recipeOperations.scrape.mutationOptions());
  const parseHtmlMutation = useMutation(
    recipeOperations.parseHtml.mutationOptions(),
  );

  // Get the recipe entity in edit mode
  const recipe = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;
  const initialUrl = mode === "create" ? props.initialUrl : undefined;
  const autoScrape = mode === "create" ? props.autoScrape : false;

  // Initialize form with default values or existing recipe data
  const form = useForm<RecipeFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: recipeToFormValues(recipe, initialName, initialUrl),
  });

  // Set up field arrays for sections
  const {
    fields: sectionFields,
    append: appendSection,
    remove: removeSection,
    move: moveSection,
    replace: replaceSections,
  } = useFieldArray({
    control: form.control,
    name: "sections",
  });

  // Imperative per-section ingredient resolver for scraped recipes.
  const { resolveGroups, isResolving, progress } = useIngredientResolver();

  // Scraped image URL, handed to PendingImageUpload for auto-import.
  const [scrapedImageUrl, setScrapedImageUrl] = useState<string | null>(null);
  // A pending import (URL scrape or pasted HTML) awaiting overwrite confirmation;
  // non-null while the confirm dialog is open. Running it replaces form contents.
  const [pendingImport, setPendingImport] = useState<(() => void) | null>(null);

  // Watch URL field for scrape button
  const urlValue = useWatch({ control: form.control, name: "meta.url" });

  // Does the form already hold user-entered content a scrape would clobber?
  const formHasContent = () =>
    form
      .getValues("sections")
      .some(
        (s) =>
          (s.ingredients?.length ?? 0) > 0 ||
          (s.instructions?.length ?? 0) > 0 ||
          (s.name?.trim().length ?? 0) > 0,
      );

  // Populate the structured section editor from an imported recipe, preserving
  // section names and boundaries (auto-creates missing ingredients). Shared by
  // both the URL scrape and the pasted-HTML fallback.
  const applyImportResult = async (result: ImportRecipe) => {
    // Resolve each section's ingredient lines into structured form ingredients
    // BEFORE writing anything to the form: this is the only step that can fail,
    // and a half-applied import (recipe name set, no sections) reads as a
    // successful scrape of an empty recipe.
    const ingredientGroups = await resolveGroups(
      result.sections.map((section) => section.ingredients),
    );

    // Set recipe name if empty
    if (!form.getValues("name")) {
      form.setValue("name", result.meta.title);
    }

    replaceSections(
      result.sections.map((section, i) => ({
        name: section.name ?? null,
        ingredients: ingredientGroups[i] ?? [],
        instructions: section.instructions.map((instruction) => ({
          instruction,
        })),
      })),
    );

    // Set servings if available from scraper
    if (result.servings) {
      form.setValue("servings", result.servings);
    }

    // Set yield if available. The scraper returns structured {value, unit};
    // a freeform string (other sources) is parsed via WASM.
    const ry = result.meta.recipe_yield;
    const yieldText = z.string().safeParse(ry);
    const yieldStruct = yieldText.success
      ? wasm.parse_yield(yieldText.data).recipe_yield
      : z.object({ value: z.number(), unit: z.string() }).nullable().parse(ry);
    if (yieldStruct) {
      form.setValue("yield", {
        value: yieldStruct.value,
        unit: yieldStruct.unit,
      });
    }

    // Hand any scraped image to PendingImageUpload for auto-import.
    if (result.image?.kind === "url") {
      setScrapedImageUrl(result.image.url);
    }

    // Surface the scraped headnote as notes unless the user already has some.
    if (result.meta.description && !form.getValues("notes")?.trim()) {
      form.setValue("notes", result.meta.description);
    }

    const ingredientCount = ingredientGroups.reduce(
      (sum, group) => sum + group.length,
      0,
    );
    toast.success(
      `Imported ${ingredientCount} ingredient${ingredientCount === 1 ? "" : "s"} across ${result.sections.length} section${result.sections.length === 1 ? "" : "s"}.`,
    );
  };

  // When a scrape can't find a recipe (many sites block bot fetches or hide the
  // recipe behind JS), point the user at the paste-HTML fallback that exists for
  // exactly this case — open that panel with the URL still populated so pasting
  // the page source keeps the recipe's source provenance.
  const offerHtmlFallback = (message: string) => {
    toast.error(message, {
      description: "The site may block scraping. Paste the page HTML instead.",
      action: {
        label: "Try Paste HTML",
        onClick: () => setOpenTool("html"),
      },
    });
  };

  // Scrape the URL and populate the form.
  const doScrape = async () => {
    if (!urlValue) return;
    try {
      const result = await scrapeMutation.mutateAsync(urlValue);
      if (!result?.sections.length) {
        offerHtmlFallback("No recipe found at that URL.");
        return;
      }
      await applyImportResult(result);
    } catch (error) {
      // Mutation fetch failures also land here (the global MutationCache toasts a
      // generic error too, but this one carries the actionable fallback).
      console.error("Scrape failed:", error);
      offerHtmlFallback(`Couldn't scrape that URL: ${getErrorMessage(error)}`);
    }
  };

  // Parse pasted page HTML and populate the form — fallback for blocked scrapes.
  // URL is required so the recipe keeps its source provenance.
  const doParseHtml = async () => {
    if (!htmlInput.trim() || !urlValue) return;
    try {
      const result = await parseHtmlMutation.mutateAsync({
        html: htmlInput,
        url: urlValue,
      });
      if (!result?.sections.length) {
        toast.error("No recipe found in that HTML.");
        return;
      }
      await applyImportResult(result);
      setHtmlInput("");
      setOpenTool(null);
    } catch (error) {
      // SILENT: parse failures are toasted by the global MutationCache
      // onError handler (parseHtmlMutation has no local onError).
      console.error("HTML parse failed:", error);
    }
  };

  // Guard an import behind a confirmation when it would overwrite existing work.
  const confirmOrRun = (run: () => void) => {
    if (formHasContent()) {
      setPendingImport(() => run);
      return;
    }
    run();
  };
  const handleScrape = () => {
    if (!urlValue) return;
    confirmOrRun(() => void doScrape());
  };
  const handleParseHtml = () => {
    if (!htmlInput.trim() || !urlValue) return;
    confirmOrRun(() => void doParseHtml());
  };

  // A shared/deep-linked URL (PWA share target or the "Import from URL" entry
  // point) auto-runs the scrape once on mount so the user lands on a populated
  // form instead of a blank one they have to re-trigger by hand. The ref guards
  // against re-firing on re-renders (and React 18 StrictMode's double-mount).
  const autoScrapeFired = useRef(false);
  useEffect(() => {
    if (autoScrapeFired.current || !autoScrape) return;
    autoScrapeFired.current = true;
    if (initialUrl) void doScrape();
    // oxlint-disable-next-line react/exhaustive-deps -- mount-only — initialUrl/autoScrape are fixed per form instance and doScrape reads the current URL off the form
  }, []);

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
      setOpenTool(null);
    } catch (error) {
      showErrorToast(error);
    }
  };

  const handleSubmit = (values: RecipeFormValues) => {
    if (mode === "create") {
      props.onCreate(recipeFormValuesToCreateInput(values, getImageData(true)));
    } else if (mode === "edit" && recipe) {
      const updateData = recipeFormValuesToUpdateInput(
        values,
        recipe,
        getImageData(),
        hasImageChanges(),
      );

      if (updateData) {
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
      stickyFooter
      footerStart={<EditorTally control={form.control} />}
    >
      <div className="gap-6 xl:grid xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <Stack>
          <ImportToolsPanel
            mode={mode}
            control={form.control}
            openTool={openTool}
            onToggleTool={toggleTool}
            urlValue={urlValue}
            textImportIngredients={textImportIngredients}
            onTextImportIngredientsChange={setTextImportIngredients}
            textImportInstructions={textImportInstructions}
            onTextImportInstructionsChange={setTextImportInstructions}
            htmlInput={htmlInput}
            onHtmlInputChange={setHtmlInput}
            ingredientLines={ingredientLines}
            instructionLines={instructionLines}
            richInstructions={richInstructions}
            ingredientImport={ingredientImport}
            isResolving={isResolving}
            progress={progress}
            scrapePending={scrapeMutation.isPending}
            parseHtmlPending={parseHtmlMutation.isPending}
            onScrape={handleScrape}
            onParseHtml={handleParseHtml}
            onImportAll={handleImportAll}
          />

          {/* Spec plate: the recipe's vitals in one chunky placard */}
          <Card>
            <CardContent className="space-y-2 px-4 py-1">
              <EntityPrimitiveFields
                entity="recipe"
                mode={mode}
                section="identity"
                options={{ name: { placeholder: "Enter recipe name" } }}
              />
              <YieldServingsFields form={form} mode={mode} />
              <Controller
                control={form.control}
                name="tags"
                render={({ field }) => (
                  <FormFieldGroup htmlFor={tagsId} label="Tags (Optional)">
                    <TagInput
                      id={tagsId}
                      value={field.value}
                      onChange={field.onChange}
                    />
                  </FormFieldGroup>
                )}
              />
              <EntityPrimitiveFields
                entity="recipe"
                mode={mode}
                section="main"
                options={{
                  notes: {
                    placeholder:
                      "Headnote, do-ahead tips, serving suggestions…",
                    rows: 4,
                  },
                }}
              />
            </CardContent>
          </Card>

          {/* Photos: a first-class field. Kept always-mounted so scraped
              images still auto-import via autoImportUrl. */}
          <Card>
            <CardContent className="space-y-2 px-4 py-4">
              <h3 className="my-0 flex items-center gap-2 eyebrow font-medium">
                <ImageIcon className="size-3.5" />
                Photos
              </h3>
              <PendingImageUpload
                entityType="RECIPE"
                onImagesChange={handlePendingImagesChange}
                existingImages={
                  mode === "edit" && recipe?.images ? recipe.images : []
                }
                onExistingImagesRemove={handleRemovedImagesChange}
                autoImportUrl={scrapedImageUrl}
              />
            </CardContent>
          </Card>

          <Stack gap="sm">
            <Row align="center" justify="between">
              <h3 className="my-0 eyebrow font-medium">Recipe sections</h3>
            </Row>

            {sectionFields.map((sectionField, sectionIndex) => (
              <Stack
                key={sectionField.id}
                gap="sm"
                className="border border-[var(--border)] bg-card p-4"
              >
                <Row align="center" justify="between">
                  <h4 className="my-0 font-heading text-sm font-semibold">
                    Section {sectionIndex + 1}
                    {sectionField.name ? `: ${sectionField.name}` : ""}
                  </h4>
                  <Row gap="sm">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        moveSection(sectionIndex, Math.max(0, sectionIndex - 1))
                      }
                      disabled={sectionIndex === 0}
                    >
                      <CaretUpIcon className="size-4" />
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
                      <CaretDownIcon className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeSection(sectionIndex)}
                      disabled={sectionFields.length === 1}
                    >
                      <TrashIcon className="size-4" />
                    </Button>
                  </Row>
                </Row>

                {/* Ingredients and Instructions side by side */}
                <div className="flex flex-col space-y-2 md:flex-row md:space-y-0 md:space-x-2">
                  {/* Ingredients */}
                  <div className="md:w-1/2">
                    <h5 className="mb-2 eyebrow font-medium">Ingredients</h5>
                    <IngredientFieldArray
                      form={form}
                      sectionIndex={sectionIndex}
                    />
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
                    <h5 className="mb-2 eyebrow font-medium">Instructions</h5>
                    <InstructionFieldArray
                      form={form}
                      sectionIndex={sectionIndex}
                    />
                  </div>
                </div>
              </Stack>
            ))}

            <Row justify="center" className="mt-4">
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
                <PlusIcon className="mr-2 size-4" />
                Add Section
              </Button>
            </Row>
          </Stack>
        </Stack>

        {/* Live page preview — the cookbook spread builds as you type */}
        <aside className="hidden xl:sticky xl:top-20 xl:block">
          <div className="max-h-[75vh] overflow-y-auto border border-[var(--border)] bg-card p-4">
            <p className="mb-2 eyebrow">Live preview</p>
            <RecipeLivePreview control={form.control} />
          </div>
        </aside>
      </div>

      <AlertDialog
        open={pendingImport !== null}
        onOpenChange={(open) => {
          if (!open) setPendingImport(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Replace current recipe contents?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Importing will replace the ingredients and instructions you've
              already entered with the imported recipe. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const run = pendingImport;
                setPendingImport(null);
                run?.();
              }}
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </FormWrapper>
  );
};
