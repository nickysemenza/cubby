import { ClipboardTextIcon } from "@phosphor-icons/react/dist/csr/ClipboardText";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { type Control, Controller } from "react-hook-form";

import { Row, Stack } from "~/components/layout";
import { Button } from "~/components/ui/button";
import { Description } from "~/components/ui/description";
import { FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";

import { FormFieldGroup } from "../../forms/form-field-group";
import { formatRichText } from "../richtext";
import {
  IngredientPreviewTable,
  type useIngredientImport,
} from "./ingredient-preview-table";
import type { RecipeFormValues } from "./types";

type RichInstruction = Parameters<typeof formatRichText>[0];

type OpenTool = "scrape" | "text" | "html" | null;

function ImportToolToolbar({
  mode,
  openTool,
  onToggleTool,
}: {
  mode: "create" | "edit";
  openTool: OpenTool;
  onToggleTool: (tool: "scrape" | "text" | "html") => void;
}) {
  const tools = [
    { id: "scrape" as const, label: "Scrape URL", icon: LinkIcon },
    { id: "text" as const, label: "Paste text", icon: ClipboardTextIcon },
    { id: "html" as const, label: "Paste HTML", icon: CodeIcon },
  ];
  return (
    <Row wrap align="center" justify="between" gap="sm">
      <span className="eyebrow">
        {mode === "edit" ? "Editing recipe" : "New recipe"}
      </span>
      <Row gap="sm">
        {tools.map((tool) => (
          <Button
            key={tool.id}
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={openTool === tool.id}
            className={cn(openTool === tool.id && "bg-muted")}
            onClick={() => onToggleTool(tool.id)}
          >
            <tool.icon className="mr-2 size-3.5" />
            {tool.label}
          </Button>
        ))}
      </Row>
    </Row>
  );
}

function ScrapeImportPanel({
  control,
  open,
  urlValue,
  scrapePending,
  isResolving,
  progress,
  onScrape,
}: {
  control: Control<RecipeFormValues>;
  open: boolean;
  urlValue: string | null | undefined;
  scrapePending: boolean;
  isResolving: boolean;
  progress: { done: number; total: number };
  onScrape: () => void;
}) {
  return (
    <div
      className={cn(
        "border border-[var(--border)] bg-card p-4",
        !open && "hidden",
      )}
    >
      <FormFieldGroup label="URL (Optional)">
        <Row gap="sm">
          <Controller
            control={control}
            name="meta.url"
            render={({ field }) => (
              <Input
                placeholder="Enter recipe URL"
                value={field.value ?? ""}
                onChange={(event) => field.onChange(event.target.value || null)}
                className="flex-1"
              />
            )}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onScrape}
            disabled={!urlValue || scrapePending || isResolving}
            className="shrink-0"
          >
            {scrapePending || isResolving ? (
              <Spinner className="mr-1" />
            ) : (
              <DownloadSimpleIcon className="mr-1 size-4" />
            )}
            Scrape
          </Button>
        </Row>
        {isResolving && progress.total > 0 ? (
          <Description size="xs">
            Resolving ingredients {progress.done}/{progress.total}…
          </Description>
        ) : null}
      </FormFieldGroup>
    </div>
  );
}

/**
 * The one-time import tooling for the recipe form: a toolbar that toggles
 * between three collapsible panels — URL scrape, paste-text (with live parsed
 * previews), and paste-HTML fallback. All state and import handlers live in
 * {@link RecipeForm}; this component is the relocated panel chrome.
 */
export function ImportToolsPanel({
  mode,
  control,
  openTool,
  onToggleTool,
  urlValue,
  textImportIngredients,
  onTextImportIngredientsChange,
  textImportInstructions,
  onTextImportInstructionsChange,
  htmlInput,
  onHtmlInputChange,
  ingredientLines,
  instructionLines,
  richInstructions,
  ingredientImport,
  isResolving,
  progress,
  scrapePending,
  parseHtmlPending,
  onScrape,
  onParseHtml,
  onImportAll,
}: {
  mode: "create" | "edit";
  control: Control<RecipeFormValues>;
  openTool: OpenTool;
  onToggleTool: (tool: "scrape" | "text" | "html") => void;
  urlValue: string | null | undefined;
  textImportIngredients: string;
  onTextImportIngredientsChange: (value: string) => void;
  textImportInstructions: string;
  onTextImportInstructionsChange: (value: string) => void;
  htmlInput: string;
  onHtmlInputChange: (value: string) => void;
  ingredientLines: string[];
  instructionLines: string[];
  richInstructions: RichInstruction[];
  ingredientImport: ReturnType<typeof useIngredientImport>;
  isResolving: boolean;
  progress: { done: number; total: number };
  scrapePending: boolean;
  parseHtmlPending: boolean;
  onScrape: () => void;
  onParseHtml: () => void;
  onImportAll: () => void;
}) {
  return (
    <>
      <ImportToolToolbar
        mode={mode}
        openTool={openTool}
        onToggleTool={onToggleTool}
      />

      <ScrapeImportPanel
        control={control}
        open={openTool === "scrape"}
        urlValue={urlValue}
        scrapePending={scrapePending}
        isResolving={isResolving}
        progress={progress}
        onScrape={onScrape}
      />

      {/* Paste-text panel */}
      <Stack
        gap="sm"
        className={cn(
          "border border-[var(--border)] bg-card p-4",
          openTool !== "text" && "hidden",
        )}
      >
        {/* Ingredients: textarea + pills preview */}
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <FormFieldGroup label="Ingredients (one per line)">
            <Textarea
              placeholder="1 cup flour&#10;2 eggs&#10;1/2 tsp salt"
              value={textImportIngredients}
              onChange={(e) => onTextImportIngredientsChange(e.target.value)}
              rows={6}
            />
          </FormFieldGroup>
          <div>
            <FieldLabel>Parsed Ingredients</FieldLabel>
            <div className="mt-2 min-h-[120px] rounded border border-[var(--border)] bg-muted/30 p-2">
              <IngredientPreviewTable ingredientLines={ingredientLines} />
            </div>
          </div>
        </div>

        {/* Instructions: textarea + preview */}
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <FormFieldGroup label="Instructions (one per line)">
            <Textarea
              placeholder="Preheat oven to 350°F&#10;Mix dry ingredients&#10;Add wet ingredients"
              value={textImportInstructions}
              onChange={(e) => onTextImportInstructionsChange(e.target.value)}
              rows={6}
            />
          </FormFieldGroup>
          <div>
            <FieldLabel>Instructions Preview</FieldLabel>
            <div className="mt-2 min-h-[120px] rounded border border-[var(--border)] bg-muted/30 p-2">
              {richInstructions.length > 0 ? (
                <Stack as="ol" gap="sm" className="list-decimal pl-4 text-sm">
                  {richInstructions.map((richItems, index) => (
                    <li
                      // oxlint-disable-next-line react/no-array-index-key -- Instructions are a positional authored list without stable ids, and duplicate lines are valid.
                      key={index}
                    >
                      {formatRichText(richItems)}
                    </li>
                  ))}
                </Stack>
              ) : (
                <Description as="div">
                  Enter instructions to see preview
                </Description>
              )}
            </div>
          </div>
        </div>

        {/* Import button */}
        <Row align="center" justify="between">
          <Description as="div">
            {ingredientImport.totalCount > 0 && (
              <>
                {ingredientImport.matchedCount}/{ingredientImport.totalCount}{" "}
                ingredients matched
                {ingredientImport.missingCount > 0 && (
                  <span className="text-warning-ink">
                    {" "}
                    ({ingredientImport.missingCount} will be created)
                  </span>
                )}
              </>
            )}
          </Description>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onImportAll}
            disabled={
              ingredientImport.isLoading ||
              ingredientImport.isImporting ||
              (ingredientLines.length === 0 && instructionLines.length === 0)
            }
          >
            {ingredientImport.isImporting ? (
              <Spinner className="mr-1" />
            ) : (
              <DownloadSimpleIcon className="mr-1 size-4" />
            )}
            {ingredientImport.missingCount > 0
              ? `Import All (create ${ingredientImport.missingCount})`
              : "Import All"}
          </Button>
        </Row>
      </Stack>

      {/* Paste-HTML panel — fallback when a URL scrape is blocked. Open the
          page in your browser, View Source, copy all, and paste it here. */}
      <Stack
        gap="sm"
        className={cn(
          "border border-[var(--border)] bg-card p-4",
          openTool !== "html" && "hidden",
        )}
      >
        <FormFieldGroup label="Source URL">
          <Controller
            control={control}
            name="meta.url"
            render={({ field }) => (
              <Input
                placeholder="https://example.com/the-recipe"
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value || null)}
              />
            )}
          />
        </FormFieldGroup>
        <FormFieldGroup label="Page HTML">
          <Textarea
            placeholder="Paste the full page HTML here (open the recipe in your browser → View Source → Copy All)"
            value={htmlInput}
            onChange={(e) => onHtmlInputChange(e.target.value)}
            rows={8}
            className="font-mono text-xs"
          />
        </FormFieldGroup>
        <Row align="center" justify="between" gap="sm">
          <Description size="xs">
            The source URL is saved with the recipe and used to resolve relative
            image and link references.
          </Description>
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={onParseHtml}
            disabled={
              !htmlInput.trim() || !urlValue || parseHtmlPending || isResolving
            }
            className="shrink-0"
          >
            {parseHtmlPending || isResolving ? (
              <Spinner className="mr-1" />
            ) : (
              <DownloadSimpleIcon className="mr-1 size-4" />
            )}
            Parse HTML
          </Button>
        </Row>
      </Stack>
    </>
  );
}
