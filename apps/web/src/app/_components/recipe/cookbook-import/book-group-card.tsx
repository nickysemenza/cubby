import { useQuery } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Import,
  RotateCcw,
  X,
} from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { Row } from "~/components/layout/row";
import { BulkProgressBar } from "~/components/ui/bulk-progress-bar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { importRecipeSignature } from "~/lib/recipe-signature";
import { useTRPC } from "~/trpc/react";
import {
  RecipeImportCard,
  type RecipeImportStatus,
} from "../recipe-import-card";
import { normalize } from "./import-order";
import type { Book, BookHandlers } from "./types";

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

  // Recipes already imported from this book, by normalized title → { id, sig }.
  // The id links to the existing Cubby recipe; the content signature lets each
  // card show "no changes" vs "will update". Also lets a cross-recipe reference
  // link to a recipe that already exists.
  const { data: existingRecipes } = useQuery(
    api.recipe.getCookbookDiff.queryOptions(
      { book: name },
      { enabled: ready && name.length > 0 },
    ),
  );
  const existingByTitle = useMemo(
    () =>
      new Map(
        (existingRecipes ?? []).map((r) => [
          normalize(r.title),
          { id: r.id, sig: r.sig },
        ]),
      ),
    [existingRecipes],
  );
  const existingTitleSet = useMemo(
    () => new Set(existingByTitle.keys()),
    [existingByTitle],
  );

  // A reference links only if its target will exist after import: selected in
  // this book, or already in the book. Only meaningful once extraction is done;
  // during streaming we keep a stable empty set so memoized cards don't churn.
  const linkableTitles = useMemo<ReadonlySet<string>>(() => {
    if (!ready) return EMPTY_TITLES;
    const titles = new Set<string>(existingTitleSet);
    for (const i of book.selected) {
      titles.add(normalize(book.recipes[i]!.meta.title));
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
        <Row align="center" justify="end" gap="sm" className="flex-1 text-sm">
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
        </Row>
      </CardHeader>

      {book.expanded && (book.recipes.length > 0 || ready) && (
        <CardContent className="space-y-2">
          {ready && name.length === 0 && (
            <p className="text-warning text-xs">
              Set a book name before importing.
            </p>
          )}
          <FailedChunksPanel
            book={book}
            onRetry={() => handlers.retryExtraction(book.source)}
          />
          {!ready && book.recipes.length > 0 && (
            <Description size="xs">
              Streaming recipes as the book extracts…
            </Description>
          )}
          {book.importProgress ? (
            <BulkProgressBar verb="Importing" progress={book.importProgress} />
          ) : (
            doneCount > 0 && (
              <Description size="xs">
                {doneCount} of {book.recipes.length} imported
              </Description>
            )
          )}
          <RecipeList
            book={book}
            toggleRecipe={handlers.toggleRecipe}
            existingByTitle={existingByTitle}
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
  existingByTitle,
  linkableTitles,
}: {
  book: Book;
  toggleRecipe: BookHandlers["toggleRecipe"];
  existingByTitle: Map<string, { id: string; sig: string }>;
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

  // Stable reference-linking config so the memoized cards don't churn.
  const refConfig = useMemo(
    () => ({ linkableTitles, previewTitles, scrollToTitle }),
    [linkableTitles, previewTitles, scrollToTitle],
  );

  return (
    <div ref={scrollRef} className="max-h-[70vh] overflow-auto">
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {items.map((vi) => {
          const recipe = book.recipes[vi.index];
          if (!recipe) return null;
          const existing = existingByTitle.get(normalize(recipe.meta.title));
          // Imported recipes compare their would-be signature to the stored one
          // → "no changes" vs "will update"; un-imported ones are "new".
          const status: RecipeImportStatus = !existing
            ? "new"
            : importRecipeSignature(recipe) !== existing.sig
              ? "will-update"
              : "unchanged";
          return (
            <div
              key={vi.index}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full pb-2"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <RecipeImportCard
                recipe={recipe}
                status={status}
                existingId={existing?.id}
                selected={book.selected.has(vi.index)}
                onToggle={() => toggleRecipe(book.source, vi.index)}
                result={book.results.get(vi.index)}
                references={refConfig}
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
    return (
      <Description as="span" size="xs">
        Queued…
      </Description>
    );
  }
  if (e.status === "extracting") {
    return (
      <Row
        as="span"
        align="center"
        gap="xs"
        className="text-muted-foreground text-xs"
      >
        <Spinner className="h-3 w-3" /> Extracting {e.done}/{e.total}
      </Row>
    );
  }
  if (e.status === "error") {
    return (
      <Row
        as="span"
        align="center"
        gap="xs"
        className="text-destructive text-xs"
      >
        <AlertCircle className="h-3 w-3" /> {e.message}
      </Row>
    );
  }
  // ready
  const failed = e.failedChunks.length;
  return (
    <Description as="span" size="xs">
      {book.recipes.length} recipe{book.recipes.length === 1 ? "" : "s"}
      {failed > 0 && (
        <span className="text-warning">
          {" · "}
          {failed} chunk{failed === 1 ? "" : "s"} failed
        </span>
      )}
    </Description>
  );
}

// Lists the chunks that failed extraction (both models produced unparseable
// output, so their recipes were lost) — which source doc + why — instead of an
// opaque count, with one action to re-run extraction and recover them. Only shown
// on a ready book that has failures.
function FailedChunksPanel({
  book,
  onRetry,
}: {
  book: Book;
  onRetry: () => void;
}) {
  if (book.extract.status !== "ready" || book.extract.failedChunks.length === 0)
    return null;
  const failed = book.extract.failedChunks;
  return (
    <div className="border border-warning/40 bg-warning/5 p-2">
      <Row align="center" justify="between" gap="sm">
        <Row as="span" align="center" gap="xs" className="text-warning text-xs">
          <AlertCircle className="h-3 w-3" />
          {failed.length} chunk{failed.length === 1 ? "" : "s"} failed to
          extract — recipes in {failed.length === 1 ? "it" : "them"} were lost
        </Row>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="mr-1 h-3 w-3" />
          Retry extraction
        </Button>
      </Row>
      <ul className="mt-2 space-y-1">
        {failed.map((chunk) => (
          <li
            key={chunk.index}
            className="font-mono text-2xs text-muted-foreground"
            title={chunk.reason}
          >
            #{chunk.index}
            {chunk.docPath ? ` · ${chunk.docPath}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
