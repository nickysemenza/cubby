import type {
  CookbookExtraction,
  CookbookIngredientLine,
  CookbookRecipe,
} from "@cubby/schemas/cookbook";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { DownloadSimpleIcon } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useQueries } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useId, useMemo, useRef } from "react";

import { recipe } from "~/app/recipes/recipe.functions";
import { Row } from "~/components/layout/row";
import { Stack } from "~/components/layout/stack";
import { BulkProgressBar } from "~/components/ui/bulk-progress-bar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "~/components/ui/collapsible";
import { Description } from "~/components/ui/description";
import { Image } from "~/components/ui/image";
import { Input } from "~/components/ui/input";
import { flattenRecipes } from "~/lib/cookbook-graph";
import { cookbookRecipeSignature } from "~/lib/recipe-signature";

import type { SubRecipeLink } from "../parsed-ingredient-table";
import {
  RecipeImportCard,
  type RecipeImportStatus,
} from "../recipe-import-card";
import { EstimatePanel } from "./estimate-panel";
import { ExtractProgressPanel, ExtractStatusLine } from "./extract-status";
import { normalize } from "./import-helpers";
import { parsedLinesFor, toRecipeCardView } from "./recipe-card-view";
import { FailuresPanel, RunReportPanel } from "./run-report-panel";
import type { Book, BookHandlers } from "./types";

type ExistingRecipe = { id: string; sig: string; hasImage: boolean };

/**
 * One row of the book's tree.
 *
 * Techniques and essays ride on their chapter row rather than getting rows of
 * their own: they are not importable, but hiding them entirely would suggest
 * the extractor skipped that part of the book. Collapsed context says the whole
 * book was read and this piece of it simply is not a recipe.
 */
type TreeRow =
  | {
      kind: "chapter";
      key: string;
      title: string;
      context: { id: string; title: string; kind: "technique" | "essay" }[];
    }
  | {
      kind: "recipe";
      key: string;
      item: CookbookRecipe;
      chapter: string | null;
    };

const buildRows = (extraction: CookbookExtraction): TreeRow[] =>
  extraction.chapters.flatMap((chapter) => {
    const context = chapter.items.flatMap((item) =>
      item.kind === "recipe"
        ? []
        : [{ id: item.id, title: item.title, kind: item.kind }],
    );
    const recipes = chapter.items.flatMap<TreeRow>((item) =>
      item.kind === "recipe"
        ? [
            {
              kind: "recipe",
              key: item.id,
              item,
              chapter: chapter.title ?? null,
            },
          ]
        : [],
    );
    if (recipes.length === 0 && context.length === 0) return [];
    return [
      {
        kind: "chapter" as const,
        key: `chapter:${chapter.id}`,
        title: chapter.title ?? "(front matter)",
        context,
      },
      ...recipes,
    ];
  });

export function BookGroupCard({
  book,
  handlers,
  importing,
}: {
  book: Book;
  handlers: BookHandlers;
  importing: boolean;
}) {
  const name = book.name.trim();
  const extraction = book.extraction;
  const ready = book.extract.status === "ready" && extraction !== undefined;

  const flat = useMemo(
    () => (extraction ? flattenRecipes(extraction) : []),
    [extraction],
  );

  // Recipes already imported from this book, by normalized name → { id, sig }.
  // The id links to the existing Cubby recipe; the content signature lets each
  // card show "no changes" vs "will update". It also decides whether a
  // sub-recipe reference can link to something that is already there.
  const existingQueries =
    ready && name.length > 0
      ? [recipe.getCookbookDiff.queryOptions({ book: name })]
      : [];
  const [existingQuery] = useQueries({ queries: existingQueries });
  const existingByName = useMemo(
    () =>
      new Map<string, ExistingRecipe>(
        (existingQuery?.data ?? []).map((row) => [
          normalize(row.title),
          { id: row.id, sig: row.sig, hasImage: row.hasImage },
        ]),
      ),
    [existingQuery?.data],
  );

  const allSelected = flat.length > 0 && book.selected.size === flat.length;

  return (
    <Card size="sm">
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        {ready && flat.length > 0 ? (
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
            <CaretDownIcon className="size-4" />
          ) : (
            <CaretRightIcon className="size-4" />
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
          <ExtractStatusLine book={book} recipeCount={flat.length} />
          {ready && flat.length > 0 && (
            <Button
              type="button"
              size="sm"
              onClick={() => handlers.import(book.source)}
              disabled={
                importing || book.selected.size === 0 || name.length === 0
              }
            >
              <DownloadSimpleIcon className="mr-1 size-4" />
              Import {book.selected.size}
            </Button>
          )}
          <button
            type="button"
            onClick={() => handlers.remove(book.source)}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Remove book"
          >
            <XIcon className="size-4" />
          </button>
        </Row>
      </CardHeader>

      {book.expanded && (
        <BookDetails
          book={book}
          handlers={handlers}
          ready={ready}
          name={name}
          recipeCount={flat.length}
          existingByName={existingByName}
        />
      )}
    </Card>
  );
}

function BookDetails({
  book,
  handlers,
  ready,
  name,
  recipeCount,
  existingByName,
}: {
  book: Book;
  handlers: BookHandlers;
  ready: boolean;
  name: string;
  recipeCount: number;
  existingByName: Map<string, ExistingRecipe>;
}) {
  const extraction = book.extraction;
  return (
    <CardContent className="space-y-2">
      <BookIdentity book={book} />

      {ready && name.length === 0 && (
        <p className="text-xs text-warning-ink">
          Set a book name before importing.
        </p>
      )}

      {book.extract.status === "opened" && book.estimate && (
        <EstimatePanel
          estimate={book.estimate}
          onExtract={() => handlers.extract(book.source)}
        />
      )}

      {book.extract.status === "extracting" && (
        <ExtractProgressPanel
          progress={book.extract.progress}
          onCancel={() => handlers.cancel(book.source)}
        />
      )}

      {book.report && (
        <>
          <FailuresPanel
            report={book.report}
            // Retrying needs the EPUB (a book loaded from stored source or JSON
            // has only the tree), and a run already in flight is the retry.
            canRetry={
              book.hasArchiveBytes === true &&
              book.extract.status !== "extracting"
            }
            onRetry={() => handlers.retryExtraction(book.source)}
          />
          <RunReportPanel report={book.report} />
        </>
      )}

      <PhotoImportControls
        book={book}
        handlers={handlers}
        existingByName={existingByName}
      />

      <ImportProgress book={book} total={recipeCount} />

      {ready && extraction && (
        <BookTree
          book={book}
          extraction={extraction}
          handlers={handlers}
          existingByName={existingByName}
        />
      )}
    </CardContent>
  );
}

/** Cover, title, authors — what the outline says before anything is extracted. */
function BookIdentity({ book }: { book: Book }) {
  const outline = book.outline;
  if (!outline && !book.coverPreviewUrl) return null;
  return (
    <Row align="start" gap="sm">
      {book.coverPreviewUrl && (
        <Image
          src={book.coverPreviewUrl}
          alt=""
          displayWidth={64}
          className="h-20 w-auto rounded object-contain"
        />
      )}
      {outline && (
        <Stack gap="xs">
          <span className="text-sm font-medium">{outline.title}</span>
          {outline.authors.length > 0 && (
            <Description size="xs">{outline.authors.join(", ")}</Description>
          )}
          <Description size="xs">
            {outline.chapters} chapter{outline.chapters === 1 ? "" : "s"} ·{" "}
            {outline.navRecipeTitles} recipe
            {outline.navRecipeTitles === 1 ? "" : "s"} in contents ·{" "}
            {outline.lines} lines
          </Description>
        </Stack>
      )}
    </Row>
  );
}

function ImportProgress({ book, total }: { book: Book; total: number }) {
  const doneCount = [...book.results.values()].filter(
    (result) => result.status === "done",
  ).length;
  if (book.importProgress) {
    return <BulkProgressBar verb="Importing" progress={book.importProgress} />;
  }
  if (doneCount === 0) return null;
  return (
    <Description size="xs">
      {doneCount} of {total} imported
    </Description>
  );
}

function PhotoImportControls({
  book,
  handlers,
  existingByName,
}: {
  book: Book;
  handlers: BookHandlers;
  existingByName: Map<string, ExistingRecipe>;
}) {
  const originalEpubInputId = useId();
  const recipesById = useMemo(
    () =>
      new Map(
        (book.extraction ? flattenRecipes(book.extraction) : []).map(
          (entry) => [entry.recipe.id, entry.recipe] as const,
        ),
      ),
    [book.extraction],
  );
  const needsOriginalEpub = [...book.selected].some((id) => {
    const item = recipesById.get(id);
    return (
      item !== undefined &&
      item.photos.length > 0 &&
      !existingByName.get(normalize(item.name))?.hasImage
    );
  });
  const photoWarningCount = [...book.photos.values()].filter(
    (photo) => photo.status === "error" || photo.status === "missing-bytes",
  ).length;

  return (
    <>
      {needsOriginalEpub && !book.hasArchiveBytes && (
        <Row
          align="center"
          gap="sm"
          className="border border-warning/40 bg-warning/5 p-2"
        >
          <Description as="span" size="xs" className="text-warning-ink">
            Recipe photos need the original EPUB.
          </Description>
          <label
            htmlFor={originalEpubInputId}
            className="cursor-pointer text-xs font-medium text-primary hover:underline"
          >
            Choose original EPUB
          </label>
          <Input
            id={originalEpubInputId}
            type="file"
            accept=".epub,application/epub+zip"
            className="hidden"
            aria-label={`Original EPUB for ${book.name}`}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handlers.bindOriginalEpub(book.source, file);
              event.target.value = "";
            }}
          />
        </Row>
      )}
      {book.photoProgress ? (
        <BulkProgressBar verb="Adding photos" progress={book.photoProgress} />
      ) : photoWarningCount > 0 ? (
        <Description size="xs" className="text-warning-ink">
          {photoWarningCount} recipe photo
          {photoWarningCount === 1 ? " needs attention" : "s need attention"}
        </Description>
      ) : null}
    </>
  );
}

/**
 * The book, virtualized.
 *
 * A 200-recipe book is far too much to render at once, and every card runs a
 * batched ingredient-match query when it mounts, so only the rows in or near
 * the viewport exist. That is also what makes "jump to the sub-recipe" work:
 * scrolling to a row index brings an unmounted card into being.
 */
function BookTree({
  book,
  extraction,
  handlers,
  existingByName,
}: {
  book: Book;
  extraction: CookbookExtraction;
  handlers: BookHandlers;
  existingByName: Map<string, ExistingRecipe>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => buildRows(extraction), [extraction]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 360,
    overscan: 4,
  });

  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, index) => {
      if (row.kind === "recipe") map.set(row.item.id, index);
    });
    return map;
  }, [rows]);

  // Read the row index through a ref so `scrollToId` stays referentially
  // stable, and the memoized cards don't churn when the map is rebuilt.
  const rowIndexRef = useRef(rowIndexById);
  rowIndexRef.current = rowIndexById;
  const scrollToId = useCallback(
    (id: string) => {
      const index = rowIndexRef.current.get(id);
      if (index != null) virtualizer.scrollToIndex(index, { align: "start" });
    },
    [virtualizer],
  );

  const namesById = useMemo(
    () =>
      new Map(
        flattenRecipes(extraction).map(
          (entry) => [entry.recipe.id, entry.recipe.name] as const,
        ),
      ),
    [extraction],
  );

  // A reference links only if its target will exist once this import finishes:
  // selected here, or already imported from this book. Anything else stays a
  // plain ingredient line, and the chip says so rather than promising a link.
  const linkFor = useCallback(
    (line: CookbookIngredientLine): SubRecipeLink | undefined => {
      const ref = line.ref;
      // Only an ingredient-position reference becomes a recipe link on import;
      // a mention in a step or a note is prose, not a dependency.
      if (!ref || ref.kind !== "ingredient") return undefined;
      const targetId = ref.target_id;
      const targetName = namesById.get(targetId);
      if (!targetName) return undefined;
      const linkable =
        book.selected.has(targetId) ||
        existingByName.has(normalize(targetName));
      // A target outside the rendered list (there is none today, but a filtered
      // view would have some) gets a chip without a jump rather than a jump
      // that scrolls nowhere.
      const listed = rowIndexById.has(targetId);
      const link: SubRecipeLink = { targetId, label: targetName, linkable };
      if (listed) link.onJump = () => scrollToId(targetId);
      return link;
    },
    [book.selected, existingByName, namesById, rowIndexById, scrollToId],
  );

  // Card views and parsed lines are built for the whole book rather than per
  // visible row: they are plain array mapping (no WASM, no queries), and
  // building them here keeps each card's props referentially stable so the
  // memoized card actually skips work between renders.
  const cardViews = useMemo(
    () =>
      new Map(
        flattenRecipes(extraction).map(
          (entry) => [entry.recipe.id, toRecipeCardView(entry.recipe)] as const,
        ),
      ),
    [extraction],
  );
  const parsedLines = useMemo(
    () =>
      new Map(
        flattenRecipes(extraction).map(
          (entry) =>
            [entry.recipe.id, parsedLinesFor(entry.recipe, linkFor)] as const,
        ),
      ),
    [extraction, linkFor],
  );

  return (
    <div ref={scrollRef} className="max-h-[70vh] overflow-auto">
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          return (
            <div
              key={row.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full pb-2"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              {row.kind === "chapter" ? (
                <ChapterRow title={row.title} context={row.context} />
              ) : (
                <RecipeRow
                  book={book}
                  row={row}
                  handlers={handlers}
                  existingByName={existingByName}
                  cardView={cardViews.get(row.item.id)}
                  parsedLines={parsedLines.get(row.item.id)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChapterRow({
  title,
  context,
}: {
  title: string;
  context: { id: string; title: string; kind: "technique" | "essay" }[];
}) {
  return (
    <Stack gap="xs" className="pt-2">
      <div className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </div>
      {context.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground">
            <CaretDownIcon className="size-3" />
            {context.length} technique{context.length === 1 ? "" : "s"} / essay
            {context.length === 1 ? "" : "s"} — read, not importable
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="mt-1 space-y-0.5 pl-4 text-2xs text-muted-foreground">
              {context.map((item) => (
                <li key={item.id}>
                  {item.title}
                  <span className="opacity-60"> · {item.kind}</span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </Stack>
  );
}

function RecipeRow({
  book,
  row,
  handlers,
  existingByName,
  cardView,
  parsedLines,
}: {
  book: Book;
  row: Extract<TreeRow, { kind: "recipe" }>;
  handlers: BookHandlers;
  existingByName: Map<string, ExistingRecipe>;
  cardView: ReturnType<typeof toRecipeCardView> | undefined;
  parsedLines: ReturnType<typeof parsedLinesFor> | undefined;
}) {
  const item = row.item;
  const existing = existingByName.get(normalize(item.name));
  // An imported recipe compares its would-be signature to the stored one →
  // "no changes" vs "will update"; anything not yet imported is "new".
  const status: RecipeImportStatus = !existing
    ? "new"
    : cookbookRecipeSignature(item, row.chapter) !== existing.sig
      ? "will-update"
      : "unchanged";
  if (!cardView) return null;
  return (
    <RecipeImportCard
      recipe={cardView}
      status={status}
      existingId={existing?.id}
      selected={book.selected.has(item.id)}
      onToggle={() => handlers.toggleRecipe(book.source, item.id)}
      result={book.results.get(item.id)}
      photo={book.photos.get(item.id)}
      photoPreviewUrl={book.photoPreviewUrls.get(item.id)}
      onRetryPhoto={() => handlers.retryPhoto(book.source, item.id)}
      parsedLines={parsedLines}
    />
  );
}
