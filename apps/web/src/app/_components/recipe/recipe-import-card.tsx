import {
  composeNotesMarkdown,
  type ImportRecipe,
} from "@cubby/schemas/import-recipe";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Check, ExternalLink } from "lucide-react";
import { memo, useMemo } from "react";
import { MarkdownText } from "~/components/markdown";
import { Checkbox } from "~/components/ui/checkbox";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { dedupe } from "~/misc/array-helpers";
import { EntityPillLink } from "../EntityPill";
import { normalize } from "./cookbook-import/import-order";
import type { ImportResult } from "./cookbook-import/types";
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
export type ReferenceLinking = {
  linkableTitles: ReadonlySet<string>;
  previewTitles: ReadonlySet<string>;
  scrollToTitle: (title: string) => void;
};

export type RecipeImportCardProps = {
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
function recipeSignature(r: ImportRecipe): string {
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
  { label: string; tone: string }
> = {
  new: { label: "new", tone: "bg-positive/10 text-positive" },
  unchanged: {
    label: "imported · no changes",
    tone: "bg-muted text-muted-foreground",
  },
  "will-update": {
    label: "imported · will update",
    tone: "bg-amber-100 text-amber-700",
  },
  "needs-formatting": {
    label: "needs formatting",
    tone: "bg-destructive/10 text-destructive",
  },
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
    // (the recipe's identity) changes the signature too, which already triggers
    // a re-render with a fresh closure.
    recipeSignature(a.recipe) === recipeSignature(b.recipe),
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
      dedupe(
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
    <div className="rounded border border-border p-2">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={selected}
          disabled={disabled}
          onCheckedChange={onToggle}
        />
        <div className="flex flex-1 flex-wrap items-center gap-2">
          <span
            className={cn("font-medium", disabled && "text-muted-foreground")}
          >
            {recipe.meta.title || "(untitled)"}
          </span>
          {recipe.meta.recipe_yield && (
            <span className="text-muted-foreground text-xs">
              {recipe.meta.recipe_yield}
            </span>
          )}
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 font-medium text-xs",
              badge.tone,
            )}
          >
            {badge.label}
          </span>
          {existingId && (
            <EntityPillLink
              entity="recipe"
              data={{ id: existingId, name: recipe.meta.title }}
              compact
            />
          )}
        </div>
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
        <CopyJsonButton
          value={recipe}
          title="Copy the full extracted recipe as JSON (for an ingredient-parser session)"
          toastLabel="Copied recipe JSON"
        />
        <ImportStatus result={result} />
      </div>

      {reasons && reasons.length > 0 && (
        <p className="mt-1 pl-6 text-destructive text-xs">
          {reasons.join(" ")}
        </p>
      )}

      {notesMarkdown && (
        <MarkdownText className="mt-2 text-muted-foreground text-xs">
          {notesMarkdown}
        </MarkdownText>
      )}

      {references && recipe.references.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted-foreground">Uses:</span>
          {recipe.references.map((ref) => {
            const linkable = references.linkableTitles.has(
              normalize(ref.title),
            );
            const inPreview = references.previewTitles.has(
              normalize(ref.title),
            );
            const className = cn(
              "rounded-sm px-1.5 py-0.5 font-medium",
              linkable
                ? "bg-accent/20 text-accent-foreground"
                : "bg-muted text-muted-foreground",
            );
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
        </div>
      )}

      <div className="mt-2 grid gap-x-4 gap-y-2 md:grid-cols-2">
        <div className="space-y-2">
          {recipe.sections.map((section, si) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed ordered list
            <div key={si} className="space-y-0.5">
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
            </div>
          ))}
        </div>
        <div className="space-y-2">
          {recipe.sections.map((section, si) =>
            section.instructions.length > 0 ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed ordered list
              <div key={si} className="space-y-0.5">
                {section.name && (
                  <div className="font-medium text-muted-foreground text-xs">
                    {section.name}
                  </div>
                )}
                <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground text-xs leading-snug">
                  {richBySection[si]?.map((rich, ii) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: ordered by line
                    <li key={ii}>{rich}</li>
                  ))}
                </ol>
              </div>
            ) : null,
          )}
        </div>
      </div>
    </div>
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
    <span className="flex items-center gap-1 text-destructive text-sm">
      <AlertCircle className="h-4 w-4" /> {result.message}
    </span>
  );
}
