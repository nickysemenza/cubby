import {
  composeNotesMarkdown,
  type ImportRecipe,
} from "@cubby/schemas/import-recipe";
import { ArrowCounterClockwiseIcon as RotateCcw } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ArrowSquareOutIcon as ExternalLink } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckIcon as Check } from "@phosphor-icons/react/dist/csr/Check";
import { WarningCircleIcon as AlertCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { Link } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { memo, useMemo } from "react";

import { Row, Stack } from "~/components/layout";
import { MarkdownText } from "~/components/markdown";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { Spinner } from "~/components/ui/spinner";
import { StatusText } from "~/components/ui/status-text";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";

import {
  entityDisplayImageKey,
  useEntityDisplayImages,
} from "../entity-media/entity-display-images";
import { EntityInlineLink } from "../EntityInlineLink";
import type { ImportResult, PhotoResult } from "./cookbook-import/types";
import { CopyImportRecipeParseButton } from "./copy-corpus-button";
import { CopyJsonButton } from "./copy-debug-button";
import {
  ParsedIngredientTable,
  type ParsedLineRow,
} from "./parsed-ingredient-table";
import { formatRichText, parseRichTextSafe } from "./richtext";
import { useIngredientMatches } from "./use-ingredient-matches";

// Unified status shared by both importers. Cookbook never produces
// "needs-formatting"; the rest mean the same on both.
export type RecipeImportStatus =
  | "new"
  | "unchanged"
  | "will-update"
  | "needs-formatting";

const isRecipeYieldText = (value: unknown): value is string =>
  typeof value === "string";

type RecipeImportCardProps = {
  /** The recipe to preview, in the cookbook shape (both importers map to this). */
  recipe: ImportRecipe;
  status: RecipeImportStatus;
  /** The existing Cubby recipe id, when already imported — drives the link pill. */
  existingId?: string;
  /** Why a recipe isn't importable (needs-formatting), shown under the title. */
  reasons?: string[];
  selected: boolean;
  disabled?: boolean;
  onToggle: () => void;
  result?: ImportResult;
  photo?: PhotoResult;
  photoPreviewUrl?: string;
  onRetryPhoto?: () => void;
  /**
   * One entry per section, in section order: a parse the caller already holds.
   * The cookbook importer passes the `cookbook` crate's own reading, which the
   * import persists verbatim (along with any sub-recipe link it resolved), so
   * the preview shows what will be stored rather than a second opinion. Absent
   * for the Notion / scrape path, whose lines are parsed here.
   */
  parsedLines?: readonly (readonly ParsedLineRow[])[];
  /** External source link (e.g. the Notion page); shown as a ↗ in the header. */
  externalUrl?: string;
};

/** Cheap structural signature so memoized cards skip re-render unless content changed. */
function recipeMemoKey(r: ImportRecipe): string {
  let ings = 0;
  let ins = 0;
  for (const s of r.sections) {
    ings += s.ingredients.length;
    ins += s.instructions.length;
  }
  return `${r.meta.title}|${r.sections.length}|${ings}|${ins}|${r.meta.recipe_yield ?? ""}|${r.meta.description?.length ?? 0}|${r.meta.notes?.length ?? 0}`;
}

const STATUS_BADGE = {
  new: { label: "new", variant: "positive" },
  unchanged: { label: "imported · no changes", variant: "secondary" },
  "will-update": { label: "imported · will update", variant: "warning" },
  "needs-formatting": { label: "needs formatting", variant: "destructive" },
} satisfies Record<
  RecipeImportStatus,
  {
    label: string;
    variant: "positive" | "secondary" | "warning" | "destructive";
  }
>;

export const RecipeImportCard = memo(
  RecipeImportCardImpl,
  (a, b) =>
    a.status === b.status &&
    a.existingId === b.existingId &&
    a.selected === b.selected &&
    a.disabled === b.disabled &&
    a.result === b.result &&
    a.photo === b.photo &&
    a.photoPreviewUrl === b.photoPreviewUrl &&
    a.parsedLines === b.parsedLines &&
    a.externalUrl === b.externalUrl &&
    (a.reasons ?? []).join("|") === (b.reasons ?? []).join("|") &&
    // onToggle is intentionally not compared: its only state-dependent capture
    // (the recipe's identity) changes the memo key too, which already triggers
    // a re-render with a fresh closure.
    recipeMemoKey(a.recipe) === recipeMemoKey(b.recipe),
);

function RecipeImportCardImpl({
  recipe,
  status,
  existingId,
  reasons,
  selected,
  disabled,
  onToggle,
  result,
  photo,
  photoPreviewUrl,
  onRetryPhoto,
  parsedLines,
  externalUrl,
}: RecipeImportCardProps) {
  const existingRecipeRefs = useMemo(
    () =>
      existingId
        ? [{ entityType: "recipe" as const, entityId: existingId }]
        : [],
    [existingId],
  );
  const existingRecipeImages = useEntityDisplayImages(existingRecipeRefs);
  // This recipe's ingredient names — used both to match against the DB and to
  // highlight ingredients in the instructions. When the caller supplied a parse
  // (the cookbook path), read the names off it rather than parsing again: a
  // second, disagreeing reading would highlight words the import never links.
  const ingredientNames = useMemo(
    () =>
      uniq(
        (parsedLines
          ? parsedLines.flat().map((line) => line.parsed.name)
          : wasm
              .parse_ingredient_lines(
                recipe.sections.flatMap((s) => s.ingredients),
              )
              .map((parsed) => parsed.name)
        ).filter((n) => n.length > 0),
      ),
    [recipe, parsedLines],
  );

  const { matchMap } = useIngredientMatches(ingredientNames);
  const matchReady = matchMap.size > 0;

  // The notes markdown exactly as import will store it (headnote + tips).
  const notesMarkdown = composeNotesMarkdown(
    recipe.meta.description,
    recipe.meta.notes,
  );

  const richBySection = useMemo(
    () =>
      recipe.sections.map((section) =>
        section.instructions.map((line) =>
          formatRichText(parseRichTextSafe(line, ingredientNames)),
        ),
      ),
    [recipe, ingredientNames],
  );

  const badge = STATUS_BADGE[status];

  return (
    <Card size="sm">
      <CardContent>
        <Row align="center" gap="sm">
          <Checkbox
            checked={selected}
            disabled={disabled}
            onCheckedChange={onToggle}
            aria-label={`Select ${recipe.meta.title}`}
          />
          <Row wrap align="center" gap="sm" className="flex-1">
            <span
              className={cn("font-medium", disabled && "text-muted-foreground")}
            >
              {recipe.meta.title || "(untitled)"}
            </span>
            {recipe.meta.recipe_yield && (
              <Description as="span" size="xs">
                {isRecipeYieldText(recipe.meta.recipe_yield)
                  ? recipe.meta.recipe_yield
                  : `${recipe.meta.recipe_yield.value} ${recipe.meta.recipe_yield.unit}`}
              </Description>
            )}
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {existingId && (
              <EntityInlineLink
                displayImage={
                  existingId
                    ? (existingRecipeImages[
                        entityDisplayImageKey({
                          entityType: "recipe",
                          entityId: existingId,
                        })
                      ] ?? null)
                    : null
                }
                entity="recipe"
                data={{
                  id: existingId,
                  name: recipe.meta.title,
                }}
                compact
              />
            )}
          </Row>
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground"
              title="Open source"
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
          <CopyImportRecipeParseButton recipe={recipe} />
          <CopyJsonButton
            value={recipe}
            title="Copy the full extracted recipe as JSON (for an ingredient-parser session)"
            toastLabel="Copied recipe JSON"
          />
          <ImportStatus result={result} />
        </Row>

        {reasons && reasons.length > 0 && (
          <StatusText as="p" tone="destructive" className="mt-1 pl-6 text-xs">
            {reasons.join(" ")}
          </StatusText>
        )}

        {photo && (
          <Row align="center" gap="sm" className="mt-2 pl-6 text-xs">
            {photoPreviewUrl && (
              <Image
                src={photoPreviewUrl}
                alt=""
                displayWidth={40}
                className="size-10 rounded object-cover"
              />
            )}
            <PhotoStatus result={photo} />
            {(photo.status === "error" || photo.status === "missing-bytes") &&
              onRetryPhoto && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={onRetryPhoto}
                >
                  <RotateCcw className="mr-1 size-3" />
                  Retry photo
                </Button>
              )}
          </Row>
        )}

        {notesMarkdown && (
          <MarkdownText className="mt-2 text-xs text-muted-foreground">
            {notesMarkdown}
          </MarkdownText>
        )}

        <div className="mt-2 grid gap-x-4 gap-y-2 md:grid-cols-2">
          <Stack gap="sm">
            {recipe.sections.map((section, sectionIndex) => (
              <Stack
                // oxlint-disable-next-line react/no-array-index-key -- Imported recipe sections are a fixed positional preview without stable ids.
                key={sectionIndex}
                gap="xs"
              >
                {section.name && (
                  <div className="text-xs font-medium text-muted-foreground">
                    {section.name}
                  </div>
                )}
                <ParsedIngredientTable
                  {...(parsedLines
                    ? { rows: parsedLines[sectionIndex] ?? [] }
                    : { lines: section.ingredients })}
                  matchMap={matchMap}
                  matchReady={matchReady}
                />
              </Stack>
            ))}
          </Stack>
          <Stack gap="sm">
            {recipe.sections.map((section, si) =>
              section.instructions.length > 0 ? (
                <Stack
                  // oxlint-disable-next-line react/no-array-index-key -- Imported recipe sections are a fixed positional preview without stable ids.
                  key={si}
                  gap="xs"
                >
                  {section.name && (
                    <div className="text-xs font-medium text-muted-foreground">
                      {section.name}
                    </div>
                  )}
                  <ol className="list-decimal space-y-1 pl-4 text-xs leading-snug text-muted-foreground">
                    {richBySection[si]?.map((rich, instructionIndex) => (
                      <li
                        // oxlint-disable-next-line react/no-array-index-key -- Instructions are a fixed positional preview, and duplicate lines are valid.
                        key={instructionIndex}
                      >
                        {rich}
                      </li>
                    ))}
                  </ol>
                </Stack>
              ) : null,
            )}
          </Stack>
        </div>
      </CardContent>
    </Card>
  );
}

function ImportStatus({ result }: { result: ImportResult | undefined }) {
  if (!result) return null;
  if (result.status === "importing") return <Spinner className="size-4" />;
  if (result.status === "done") {
    return (
      <Link
        to="/recipes/$shortcode"
        params={{ shortcode: result.id }}
        className="flex items-center gap-1 text-sm text-positive"
      >
        <Check className="size-4" /> Imported
      </Link>
    );
  }
  return (
    <Row as="span" align="center" gap="xs" className="text-sm text-destructive">
      <AlertCircle className="size-4" /> {result.message}
    </Row>
  );
}

function PhotoStatus({ result }: { result: PhotoResult }) {
  if (result.status === "ready") {
    return <span className="text-muted-foreground">Photo ready</span>;
  }
  if (result.status === "pending") {
    return (
      <Row as="span" align="center" gap="xs" className="text-muted-foreground">
        <Spinner className="size-3" /> Attaching photo…
      </Row>
    );
  }
  if (result.status === "attached" || result.status === "reused") {
    return (
      <Row as="span" align="center" gap="xs" className="text-positive">
        <Check className="size-3" />
        {result.status === "reused"
          ? "Photo already attached"
          : "Photo attached"}
        {result.cleanupWarning ? ` ${result.cleanupWarning}` : ""}
      </Row>
    );
  }
  if (result.status === "skipped-existing") {
    return (
      <span className="text-muted-foreground">Existing photo preserved</span>
    );
  }
  if ("message" in result) {
    return (
      <span className="text-warning-ink">
        {result.message}
        {result.status === "error" && result.cleanupWarning
          ? ` ${result.cleanupWarning}`
          : ""}
      </span>
    );
  }
  return null;
}
