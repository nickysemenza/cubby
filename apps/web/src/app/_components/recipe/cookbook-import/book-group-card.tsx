import {
  type CookbookRecipe,
  composeNotesMarkdown,
} from "@cubby/schemas/cookbook";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Import,
  X,
} from "lucide-react";
import { memo, useCallback, useMemo, useRef } from "react";
import { MarkdownText } from "~/components/markdown";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { wasm } from "~/lib/wasm";
import { dedupe } from "~/misc/array-helpers";
import { useTRPC } from "~/trpc/react";
import { CopyJsonButton } from "../copy-debug-button";
import { ParsedIngredientTable } from "../parsed-ingredient-table";
import { formatRichText } from "../richtext";
import { useIngredientMatches } from "../use-ingredient-matches";
import { normalize } from "./import-order";
import type { Book, BookHandlers, ImportResult } from "./types";

// Stable empty set so memoized RecipeCards see a referentially-stable
// `linkableTitles` during streaming (references only resolve once ready anyway).
const EMPTY_TITLES: ReadonlySet<string> = new Set();

export function BookGroupCard({
  book,
  handlers,
  importing,
}: {
  book: Book;
  handlers: BookHandlers;
  importing: boolean;
}) {
  const api = useTRPC();
  const name = book.name.trim();
  const ready = book.extract.status === "ready";

  // Titles already imported from this book — flags re-imports as updates and
  // lets a cross-recipe reference link to a recipe that already exists.
  const { data: existingTitles } = useQuery(
    api.recipe.getCookbookTitles.queryOptions(
      { book: name },
      { enabled: ready && name.length > 0 },
    ),
  );
  const existingTitleSet = useMemo(
    () => new Set((existingTitles ?? []).map(normalize)),
    [existingTitles],
  );

  // A reference links only if its target will exist after import: selected in
  // this book, or already in the book. Only meaningful once extraction is done;
  // during streaming we keep a stable empty set so memoized cards don't churn.
  const linkableTitles = useMemo<ReadonlySet<string>>(() => {
    if (!ready) return EMPTY_TITLES;
    const titles = new Set<string>(existingTitleSet);
    for (const i of book.selected) {
      titles.add(normalize(book.recipes[i].meta.title));
    }
    return titles;
  }, [ready, book.recipes, book.selected, existingTitleSet]);

  const allSelected =
    book.recipes.length > 0 && book.selected.size === book.recipes.length;

  const doneCount = [...book.results.values()].filter(
    (r) => r.status === "done",
  ).length;

  return (
    <Card size="sm">
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        {ready && book.recipes.length > 0 ? (
          <Checkbox
            aria-label="Select all in book"
            checked={allSelected}
            onCheckedChange={() => handlers.toggleAll(book.source)}
          />
        ) : null}
        <button
          type="button"
          onClick={() => handlers.toggleExpanded(book.source)}
          className="text-muted-foreground"
          aria-label={book.expanded ? "Collapse" : "Expand"}
        >
          {book.expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
        <Input
          value={book.name}
          onChange={(e) => handlers.rename(book.source, e.target.value)}
          placeholder="Book name"
          className="h-8 max-w-xs font-medium"
          aria-label="Book name"
        />
        <div className="flex flex-1 items-center justify-end gap-2 text-sm">
          <ExtractStatus book={book} />
          {ready && book.recipes.length > 0 && (
            <Button
              type="button"
              size="sm"
              onClick={() => handlers.import(book.source)}
              disabled={
                importing || book.selected.size === 0 || name.length === 0
              }
            >
              <Import className="mr-1 h-4 w-4" />
              Import {book.selected.size}
            </Button>
          )}
          <button
            type="button"
            onClick={() => handlers.remove(book.source)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Remove book"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </CardHeader>

      {book.expanded && (book.recipes.length > 0 || ready) && (
        <CardContent className="space-y-3">
          {ready && name.length === 0 && (
            <p className="text-amber-700 text-xs">
              Set a book name before importing.
            </p>
          )}
          {!ready && book.recipes.length > 0 && (
            <p className="text-muted-foreground text-xs">
              Streaming recipes as the book extracts…
            </p>
          )}
          {doneCount > 0 && (
            <p className="text-muted-foreground text-xs">
              {doneCount} of {book.recipes.length} imported
            </p>
          )}
          <RecipeList
            book={book}
            toggleRecipe={handlers.toggleRecipe}
            existingTitleSet={existingTitleSet}
            linkableTitles={linkableTitles}
          />
        </CardContent>
      )}
    </Card>
  );
}

// Virtualized recipe list: a 100+ recipe book is far too much to render at once
// (and re-render every streaming pass). Only the cards in/near the viewport
// mount — so each streaming update re-renders ~10 cards, not all of them, and
// `matchNames` fires only for visible recipes.
function RecipeList({
  book,
  toggleRecipe,
  existingTitleSet,
  linkableTitles,
}: {
  book: Book;
  toggleRecipe: BookHandlers["toggleRecipe"];
  existingTitleSet: Set<string>;
  linkableTitles: ReadonlySet<string>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: book.recipes.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 360,
    overscan: 4,
  });
  const items = virtualizer.getVirtualItems();

  // Map a recipe title to its index in this book, so a reference badge can scroll
  // to its target. First-wins on duplicate titles. `previewTitles` is the
  // clickability test (only references to a recipe shown here can be scrolled to).
  const titleToIndex = useMemo(() => {
    const m = new Map<string, number>();
    book.recipes.forEach((r, i) => {
      const key = normalize(r.meta.title);
      if (!m.has(key)) m.set(key, i);
    });
    return m;
  }, [book.recipes]);
  const previewTitles = useMemo<ReadonlySet<string>>(
    () => new Set(titleToIndex.keys()),
    [titleToIndex],
  );

  // Read the latest map through a ref so `scrollToTitle` stays referentially
  // stable (deps: just the stable virtualizer instance) — otherwise the memoized
  // RecipeCards would churn every streaming pass.
  const titleIndexRef = useRef(titleToIndex);
  titleIndexRef.current = titleToIndex;
  const scrollToTitle = useCallback(
    (title: string) => {
      const idx = titleIndexRef.current.get(normalize(title));
      if (idx != null) virtualizer.scrollToIndex(idx, { align: "start" });
    },
    [virtualizer],
  );

  return (
    <div ref={scrollRef} className="max-h-[70vh] overflow-auto">
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {items.map((vi) => {
          const recipe = book.recipes[vi.index];
          return (
            <div
              key={vi.index}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full pb-2"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <RecipeCard
                recipe={recipe}
                source={book.source}
                index={vi.index}
                selected={book.selected.has(vi.index)}
                onToggle={toggleRecipe}
                result={book.results.get(vi.index)}
                alreadyImported={existingTitleSet.has(
                  normalize(recipe.meta.title),
                )}
                linkableTitles={linkableTitles}
                previewTitles={previewTitles}
                scrollToTitle={scrollToTitle}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExtractStatus({ book }: { book: Book }) {
  const e = book.extract;
  if (e.status === "pending") {
    return <span className="text-muted-foreground text-xs">Queued…</span>;
  }
  if (e.status === "extracting") {
    return (
      <span className="flex items-center gap-1 text-muted-foreground text-xs">
        <Spinner className="h-3 w-3" /> Extracting {e.done}/{e.total}
      </span>
    );
  }
  if (e.status === "error") {
    return (
      <span className="flex items-center gap-1 text-destructive text-xs">
        <AlertCircle className="h-3 w-3" /> {e.message}
      </span>
    );
  }
  // ready
  return (
    <span className="text-muted-foreground text-xs">
      {book.recipes.length} recipe{book.recipes.length === 1 ? "" : "s"}
      {e.failedChunks > 0 && ` · ${e.failedChunks} chunk(s) failed`}
    </span>
  );
}

/** Cheap structural signature so memoized cards skip re-render across streaming
 * passes (which hand every recipe a new object ref) unless content changed. */
function recipeSignature(r: CookbookRecipe): string {
  let ings = 0;
  let ins = 0;
  for (const s of r.sections) {
    ings += s.ingredients.length;
    ins += s.instructions.length;
  }
  // description/notes lengths: cross-chunk merges can attach them after the
  // recipe first streams in, and the card renders them.
  return `${r.meta.title}|${r.sections.length}|${ings}|${ins}|${r.references.length}|${r.meta.recipe_yield ?? ""}|${r.meta.description?.length ?? 0}|${r.meta.notes?.length ?? 0}`;
}

const RecipeCard = memo(
  RecipeCardImpl,
  (a, b) =>
    a.selected === b.selected &&
    a.result === b.result &&
    a.alreadyImported === b.alreadyImported &&
    a.linkableTitles === b.linkableTitles &&
    a.previewTitles === b.previewTitles &&
    a.scrollToTitle === b.scrollToTitle &&
    a.onToggle === b.onToggle &&
    a.source === b.source &&
    a.index === b.index &&
    recipeSignature(a.recipe) === recipeSignature(b.recipe),
);

function RecipeCardImpl({
  recipe,
  source,
  index,
  selected,
  onToggle,
  result,
  alreadyImported,
  linkableTitles,
  previewTitles,
  scrollToTitle,
}: {
  recipe: CookbookRecipe;
  source: string;
  index: number;
  selected: boolean;
  onToggle: (source: string, index: number) => void;
  result: ImportResult | undefined;
  alreadyImported: boolean;
  linkableTitles: ReadonlySet<string>;
  previewTitles: ReadonlySet<string>;
  scrollToTitle: (title: string) => void;
}) {
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

  // One batched lookup PER RECIPE, fired as soon as the recipe renders (during
  // streaming, not gated on the whole book). Shared with the recipe form.
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

  return (
    <div className="rounded border border-border p-2">
      <div className="flex items-center gap-2">
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggle(source, index)}
        />
        <div className="flex flex-1 items-baseline gap-2">
          <span className="font-medium">{recipe.meta.title}</span>
          {recipe.meta.recipe_yield && (
            <span className="text-muted-foreground text-xs">
              {recipe.meta.recipe_yield}
            </span>
          )}
          {alreadyImported && (
            <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 font-medium text-amber-700 text-xs">
              already imported · will update
            </span>
          )}
        </div>
        <CopyJsonButton
          value={recipe}
          title="Copy the full extracted recipe as JSON (for an ingredient-parser session)"
          toastLabel="Copied recipe JSON"
        />
        <ImportStatus result={result} />
      </div>

      {notesMarkdown && (
        <MarkdownText className="mt-2 text-muted-foreground text-xs">
          {notesMarkdown}
        </MarkdownText>
      )}

      {recipe.references.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted-foreground">Uses:</span>
          {recipe.references.map((ref) => {
            const linkable = linkableTitles.has(normalize(ref.title));
            const inPreview = previewTitles.has(normalize(ref.title));
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
            // A reference to a recipe shown in this preview scrolls to it; others
            // (already-imported-only, or absent) stay plain text.
            return inPreview ? (
              <button
                key={ref.title}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  scrollToTitle(ref.title);
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
