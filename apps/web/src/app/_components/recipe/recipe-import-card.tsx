import {
  composeNotesMarkdown,
  type ImportRecipe,
} from "@cubby/schemas/import-recipe";
import { Link } from "@tanstack/react-router";
import { uniq } from "es-toolkit";
import { AlertCircle, Check, ExternalLink } from "lucide-react";
import { memo, useMemo } from "react";
import { Row, Stack } from "~/components/layout";
import { MarkdownText } from "~/components/markdown";
import { Badge, badgeVariants } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Spinner } from "~/components/ui/spinner";
import { StatusText } from "~/components/ui/status-text";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { EntityPillLink } from "../EntityPill";
import { normalize } from "./cookbook-import/import-order";
import type { ImportResult } from "./cookbook-import/types";
import { CopyImportRecipeParseButton } from "./copy-corpus-button";
import { CopyJsonButton } from "./copy-debug-button";
import { ParsedIngredientTable } from "./parsed-ingredient-table";
import { formatRichText } from "./richtext";
import { useIngredientMatches } from "./use-ingredient-matches";

// Unified status shared by both importers. Cookbook never produces
// "needs-formatting"; the rest mean the same on both.
export type RecipeImportStatus =
  | "new"
  | "unchanged"
  | "will-update"
  | "needs-formatting";

/** Cross-recipe reference linking — cookbook-only; Notion v1 has no references. */
type ReferenceLinking = {
  linkableTitles: ReadonlySet<string>;
  previewTitles: ReadonlySet<string>;
  scrollToTitle: (title: string) => void;
};

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
  references?: ReferenceLinking;
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
  return `${r.meta.title}|${r.sections.length}|${ings}|${ins}|${r.references.length}|${r.meta.recipe_yield ?? ""}|${r.meta.description?.length ?? 0}|${r.meta.notes?.length ?? 0}`;
}

const STATUS_BADGE: Record<
  RecipeImportStatus,
  {
    label: string;
    variant: "positive" | "secondary" | "warning" | "destructive";
  }
> = {
  new: { label: "new", variant: "positive" },
  unchanged: { label: "imported · no changes", variant: "secondary" },
  "will-update": { label: "imported · will update", variant: "warning" },
  "needs-formatting": { label: "needs formatting", variant: "destructive" },
};

export const RecipeImportCard = memo(
  RecipeImportCardImpl,
  (a, b) =>
    a.status === b.status &&
    a.existingId === b.existingId &&
    a.selected === b.selected &&
    a.disabled === b.disabled &&
    a.result === b.result &&
    a.references === b.references &&
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
  references,
  externalUrl,
}: RecipeImportCardProps) {
  // One parse of this recipe's ingredient names — used both to match against the
  // DB and to highlight ingredients in the instructions.
  const ingredientNames = useMemo(
    () =>
      uniq(
        recipe.sections
          .flatMap((s) => s.ingredients)
          .map((line) => wasm.parse_ingredient(line).name)
          .filter((n) => n.length > 0),
      ),
    [recipe],
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
        section.instructions.map((line) => {
          try {
            return formatRichText(wasm.parse_rich_text(line, ingredientNames));
          } catch {
            return [line] as ReturnType<typeof formatRichText>;
          }
        }),
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
          />
          <Row wrap align="center" gap="sm" className="flex-1">
            <span
              className={cn("font-medium", disabled && "text-muted-foreground")}
            >
              {recipe.meta.title || "(untitled)"}
            </span>
            {recipe.meta.recipe_yield && (
              <Description as="span" size="xs">
                {typeof recipe.meta.recipe_yield === "string"
                  ? recipe.meta.recipe_yield
                  : `${recipe.meta.recipe_yield.value} ${recipe.meta.recipe_yield.unit}`}
              </Description>
            )}
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {existingId && (
              <EntityPillLink
                entity="recipe"
                data={{ id: existingId, name: recipe.meta.title }}
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
              <ExternalLink className="h-3.5 w-3.5" />
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

        {notesMarkdown && (
          <MarkdownText className="mt-2 text-muted-foreground text-xs">
            {notesMarkdown}
          </MarkdownText>
        )}

        {references && recipe.references.length > 0 && (
          <Row wrap align="center" gap="xs" className="mt-2 text-xs">
            <span className="text-muted-foreground">Uses:</span>
            {recipe.references.map((ref) => {
              const linkable = references.linkableTitles.has(
                normalize(ref.title),
              );
              const inPreview = references.previewTitles.has(
                normalize(ref.title),
              );
              // Reuse badge styling so reference pills match the rest of the UI:
              // filled (secondary) = will link, hollow (outline) = stays an ingredient.
              const className = badgeVariants({
                variant: linkable ? "secondary" : "outline",
              });
              const label = (
                <>
                  → {ref.title}
                  {!linkable && " (not imported)"}
                </>
              );
              return inPreview ? (
                <button
                  key={ref.title}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    references.scrollToTitle(ref.title);
                  }}
                  title={
                    linkable
                      ? `Will link (${ref.confidence}) — click to jump`
                      : "In this book — click to jump"
                  }
                  className={cn(className, "cursor-pointer hover:underline")}
                >
                  {label}
                </button>
              ) : (
                <span
                  key={ref.title}
                  title={
                    linkable
                      ? `Will link (${ref.confidence})`
                      : "Target recipe not in this import — stays an ingredient"
                  }
                  className={className}
                >
                  {label}
                </span>
              );
            })}
          </Row>
        )}

        <div className="mt-2 grid gap-x-4 gap-y-2 md:grid-cols-2">
          <Stack gap="sm">
            {recipe.sections.map((section, si) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed ordered list
              <Stack key={si} gap="xs">
                {section.name && (
                  <div className="font-medium text-muted-foreground text-xs">
                    {section.name}
                  </div>
                )}
                <ParsedIngredientTable
                  lines={section.ingredients}
                  matchMap={matchMap}
                  matchReady={matchReady}
                />
              </Stack>
            ))}
          </Stack>
          <Stack gap="sm">
            {recipe.sections.map((section, si) =>
              section.instructions.length > 0 ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed ordered list
                <Stack key={si} gap="xs">
                  {section.name && (
                    <div className="font-medium text-muted-foreground text-xs">
                      {section.name}
                    </div>
                  )}
                  <ol className="list-decimal space-y-1 pl-4 text-muted-foreground text-xs leading-snug">
                    {richBySection[si]?.map((rich, ii) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: ordered by line
                      <li key={ii}>{rich}</li>
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
  if (result.status === "importing") return <Spinner className="h-4 w-4" />;
  if (result.status === "done") {
    return (
      <Link
        to="/recipes/$id"
        params={{ id: result.id }}
        className="flex items-center gap-1 text-positive text-sm"
      >
        <Check className="h-4 w-4" /> Imported
      </Link>
    );
  }
  return (
    <Row as="span" align="center" gap="xs" className="text-destructive text-sm">
      <AlertCircle className="h-4 w-4" /> {result.message}
    </Row>
  );
}
