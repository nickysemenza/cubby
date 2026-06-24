import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import { zodResolver } from "@hookform/resolvers/zod";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useMutation } from "@tanstack/react-query";
import { sumBy } from "es-toolkit";
import {
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Code,
  Image as ImageIcon,
  Import,
  Link2,
  Plus,
  Trash,
} from "lucide-react";
import { type FC, useId, useMemo, useState } from "react";
import {
  type Control,
  Controller,
  useFieldArray,
  useForm,
  useFormState,
  useWatch,
} from "react-hook-form";
import { toast } from "sonner";
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
import { Field, FieldLabel } from "~/components/ui/field";
import { InkStamp } from "~/components/ui/ink-stamp";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { useImageState } from "~/hooks/useImageState";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { useTRPC } from "~/trpc/react";
import {
  FormWrapper,
  getSubmitButtonText,
  NullableNumericField,
  SideBySideFields,
  UnifiedTextField,
} from "../../form-utils";
import { PendingImageUpload } from "../../PendingImageUpload";
import { formatRichText } from "../richtext";
import {
  recipeFormValuesToCreateInput,
  recipeFormValuesToUpdateInput,
  recipeToFormValues,
} from "./adapters";
import { IngredientFieldArray } from "./ingredient-field-array";
import {
  IngredientPreviewTable,
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

// Yield and Servings fields with smart hide behavior
const YieldServingsFields: FC<{
  form: ReturnType<typeof useForm<RecipeFormValues>>;
}> = ({ form }) => {
  const yieldUnitId = useId();
  const yieldUnit = useWatch({ control: form.control, name: "yield.unit" });

  // Show servings field if yield unit is set and not "servings"
  const showServings = yieldUnit && yieldUnit !== "servings";

  return (
    <div className="space-y-2">
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

// Live tally for the sticky footer: counts + a dirty stamp. Subscribed
// narrowly via control so keystrokes re-render this strip, not the form.
const EditorTally: FC<{ control: Control<RecipeFormValues> }> = ({
  control,
}) => {
  const sections = useWatch({ control, name: "sections" });
  // dirtyFields, not isDirty: registering the URL/yield inputs materializes
  // their objects ({url: undefined} vs null), which trips isDirty on load.
  const { dirtyFields } = useFormState({ control });
  const isDirty = Object.keys(dirtyFields).length > 0;
  const ingredients = sumBy(sections ?? [], (s) => s?.ingredients?.length ?? 0);
  const steps = sumBy(sections ?? [], (s) => s?.instructions?.length ?? 0);

  return (
    <div className="flex min-w-0 items-center gap-2 font-mono text-2xs text-muted-foreground uppercase">
      <span className="truncate tabular-nums">
        {ingredients} ingredients · {steps} steps
      </span>
      {isDirty && <InkStamp tone="red">Unsaved</InkStamp>}
    </div>
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

  // Scrape mutation + parse-only fallback for pasted HTML
  const scrapeMutation = useMutation(api.recipe.scrape.mutationOptions());
  const parseHtmlMutation = useMutation(api.recipe.parseHtml.mutationOptions());

  // Get the recipe entity in edit mode
  const recipe = mode === "edit" ? props.entity : undefined;
  const initialName = mode === "create" ? props.initialName : undefined;

  // Initialize form with default values or existing recipe data
  const form = useForm<RecipeFormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: recipeToFormValues(recipe, initialName),
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
    // Set recipe name if empty
    if (!form.getValues("name")) {
      form.setValue("name", result.meta.title);
    }

    // Resolve each section's ingredient lines into structured form
    // ingredients, then replace the section editor with the imported sections.
    const ingredientGroups = await resolveGroups(
      result.sections.map((section) => section.ingredients),
    );
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
    const yieldStruct =
      typeof ry === "string" ? wasm.parse_yield(ry).recipe_yield : ry;
    if (yieldStruct) {
      form.setValue("yield", {
        value: yieldStruct.value,
        unit: yieldStruct.unit,
      });
    }

    // Hand any scraped image to PendingImageUpload for auto-import.
    if (result.image) {
      setScrapedImageUrl(result.image);
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

  // Scrape the URL and populate the form.
  const doScrape = async () => {
    if (!urlValue) return;
    try {
      const result = await scrapeMutation.mutateAsync(urlValue);
      if (!result?.sections.length) {
        toast.error("No recipe found at that URL.");
        return;
      }
      await applyImportResult(result);
    } catch (error) {
      // Mutation failures (scrape fetch, ingredient create) are already toasted
      // by the global MutationCache onError handler; just log for debugging.
      console.error("Scrape failed:", error);
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
      // Parse failures are toasted by the global MutationCache onError handler.
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
      console.error("Import failed:", error);
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
        <div className="space-y-4">
          {/* Import toolbar — one-time tools, tucked out of the recipe's way */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="eyebrow">
              {mode === "edit" ? "Editing recipe" : "New recipe"}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={openTool === "scrape"}
                className={cn(openTool === "scrape" && "bg-muted")}
                onClick={() => toggleTool("scrape")}
              >
                <Link2 className="mr-2 h-3.5 w-3.5" />
                Scrape URL
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={openTool === "text"}
                className={cn(openTool === "text" && "bg-muted")}
                onClick={() => toggleTool("text")}
              >
                <ClipboardList className="mr-2 h-3.5 w-3.5" />
                Paste text
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-expanded={openTool === "html"}
                className={cn(openTool === "html" && "bg-muted")}
                onClick={() => toggleTool("html")}
              >
                <Code className="mr-2 h-3.5 w-3.5" />
                Paste HTML
              </Button>
            </div>
          </div>

          {/* Scrape panel (kept mounted so in-flight scrapes aren't lost) */}
          <div
            className={cn(
              "rounded-lg border border-[var(--border-chunky)] bg-card p-4",
              openTool !== "scrape" && "hidden",
            )}
          >
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
                  disabled={
                    !urlValue || scrapeMutation.isPending || isResolving
                  }
                  className="shrink-0"
                >
                  {scrapeMutation.isPending || isResolving ? (
                    <Spinner className="mr-1" />
                  ) : (
                    <Import className="mr-1 h-4 w-4" />
                  )}
                  Scrape
                </Button>
              </div>
              {isResolving && progress.total > 0 && (
                <p className="text-muted-foreground text-xs">
                  Resolving ingredients {progress.done}/{progress.total}…
                </p>
              )}
            </Field>
          </div>

          {/* Paste-text panel */}
          <div
            className={cn(
              "space-y-2 rounded-lg border border-[var(--border-chunky)] bg-card p-4",
              openTool !== "text" && "hidden",
            )}
          >
            {/* Ingredients: textarea + pills preview */}
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
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
                <div className="mt-2 min-h-[120px] rounded border border-border bg-muted/30 p-2">
                  <IngredientPreviewTable ingredientLines={ingredientLines} />
                </div>
              </div>
            </div>

            {/* Instructions: textarea + preview */}
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
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
                <div className="mt-2 min-h-[120px] rounded border border-border bg-muted/30 p-2">
                  {richInstructions.length > 0 ? (
                    <ol className="list-decimal space-y-2 pl-4 text-sm">
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
                    {ingredientImport.matchedCount}/
                    {ingredientImport.totalCount} ingredients matched
                    {ingredientImport.missingCount > 0 && (
                      <span className="text-warning">
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
                  (ingredientLines.length === 0 &&
                    instructionLines.length === 0)
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
          </div>

          {/* Paste-HTML panel — fallback when a URL scrape is blocked. Open the
              page in your browser, View Source, copy all, and paste it here. */}
          <div
            className={cn(
              "space-y-2 rounded-lg border border-[var(--border-chunky)] bg-card p-4",
              openTool !== "html" && "hidden",
            )}
          >
            <Field>
              <FieldLabel>Source URL</FieldLabel>
              <Controller
                control={form.control}
                name="meta.url"
                render={({ field }) => (
                  <Input
                    placeholder="https://example.com/the-recipe"
                    value={field.value ?? ""}
                    onChange={(e) => field.onChange(e.target.value || null)}
                  />
                )}
              />
            </Field>
            <Field>
              <FieldLabel>Page HTML</FieldLabel>
              <Textarea
                placeholder="Paste the full page HTML here (open the recipe in your browser → View Source → Copy All)"
                value={htmlInput}
                onChange={(e) => setHtmlInput(e.target.value)}
                rows={8}
                className="font-mono text-xs"
              />
            </Field>
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">
                The source URL is saved with the recipe and used to resolve
                relative image and link references.
              </p>
              <Button
                type="button"
                variant="default"
                size="sm"
                onClick={handleParseHtml}
                disabled={
                  !htmlInput.trim() ||
                  !urlValue ||
                  parseHtmlMutation.isPending ||
                  isResolving
                }
                className="shrink-0"
              >
                {parseHtmlMutation.isPending || isResolving ? (
                  <Spinner className="mr-1" />
                ) : (
                  <Import className="mr-1 h-4 w-4" />
                )}
                Parse HTML
              </Button>
            </div>
          </div>

          {/* Spec plate: the recipe's vitals in one chunky placard */}
          <Card>
            <CardContent className="space-y-2 px-4 py-1">
              <UnifiedTextField
                form={form}
                name="name"
                label="Name"
                placeholder="Enter recipe name"
                nullable={false}
              />
              <YieldServingsFields form={form} />
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
              <Controller
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="notes">
                      Notes (Optional, Markdown)
                    </FieldLabel>
                    <Textarea
                      placeholder="Headnote, do-ahead tips, serving suggestions…"
                      value={field.value ?? ""}
                      onChange={(e) => field.onChange(e.target.value || null)}
                      rows={4}
                    />
                  </Field>
                )}
              />
            </CardContent>
          </Card>

          {/* Photos: a first-class field. Kept always-mounted so scraped
              images still auto-import via autoImportUrl. */}
          <Card>
            <CardContent className="space-y-2 px-4 py-4">
              <h3 className="eyebrow my-0 flex items-center gap-2 font-medium">
                <ImageIcon className="h-3.5 w-3.5" />
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

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="eyebrow my-0 font-medium">Recipe sections</h3>
            </div>

            {sectionFields.map((sectionField, sectionIndex) => (
              <div
                key={sectionField.id}
                className="space-y-2 rounded-lg border border-[var(--border-chunky)] bg-card p-4 shadow-[var(--shadow-chunky-sm)]"
              >
                <div className="flex items-center justify-between">
                  <h4 className="my-0 font-heading font-semibold text-sm">
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
                <div className="flex flex-col space-y-2 md:flex-row md:space-x-2 md:space-y-0">
                  {/* Ingredients */}
                  <div className="md:w-1/2">
                    <h5 className="eyebrow mb-2 font-medium">Ingredients</h5>
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
                    <h5 className="eyebrow mb-2 font-medium">Instructions</h5>
                    <InstructionFieldArray
                      form={form}
                      sectionIndex={sectionIndex}
                    />
                  </div>
                </div>
              </div>
            ))}

            <div className="mt-4 flex justify-center">
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
        </div>

        {/* Live page preview — the cookbook spread builds as you type */}
        <aside className="hidden xl:sticky xl:top-20 xl:block">
          <div className="max-h-[75vh] overflow-y-auto rounded-lg border border-[var(--border-chunky)] bg-card p-4 shadow-[var(--shadow-chunky)]">
            <p className="eyebrow mb-2">Live preview</p>
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
