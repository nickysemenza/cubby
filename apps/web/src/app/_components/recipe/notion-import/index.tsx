import type { notionPreviewOut } from "@cubby/schemas/import-recipe";
import { ArrowCounterClockwiseIcon as RotateCcw } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { DownloadSimpleIcon as Import } from "@phosphor-icons/react/dist/csr/DownloadSimple";
import { MagnifyingGlassIcon as Search } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { WarningCircleIcon as AlertCircle } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useMemo, useRef, useState } from "react";
import type { z } from "zod";

import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { recipe, recipeStreams } from "~/app/recipes/recipe.functions";
import { Row } from "~/components/layout/row";
import { Stack } from "~/components/layout/stack";
import { BulkProgressBar } from "~/components/ui/bulk-progress-bar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { Spinner } from "~/components/ui/spinner";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { getErrorMessage } from "~/lib/error-utils";

import type { ImportResult } from "../cookbook-import/types";
import { RecipeImportCard } from "../recipe-import-card";
import {
  filterNotionPreview,
  type NotionPreviewFilter,
  updateVisibleSelection,
} from "./preview-filters";

// Sourced from the procedure's `.output(z.array(notionPreviewItem))` so this
// can never drift from the server shape.
type PreviewItem = z.output<typeof notionPreviewOut>[number];

/**
 * Import recipes from the Notion "Recipes" database. Mirrors the cookbook
 * importer's preview-then-commit flow, minus the EPUB acquisition phase: the
 * preview auto-loads on mount (parsing every row server-side), the list (the
 * shared {@link RecipeImportCard}) lets you pick a subset (non-conforming rows
 * are disabled with reasons), and a per-recipe loop commits with live status.
 * Re-import is keyed on the Notion page id.
 */
export function NotionImport() {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ImportResult>>(new Map());
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<NotionPreviewFilter>("all");
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  // Notion previews are expensive (a complete database read and parse), so they
  // remain fresh for this session. Refresh is deliberate; successful imports
  // invalidate this cache so statuses reflect the committed recipes.
  const preview = useQuery({
    ...recipe.previewNotionSync.queryOptions(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  // Per-page outcome streamed back from importNotionSyncStream, keyed by page id.
  const { start: startNotionImport } = useBulkStream<
    | {
        pageId: string;
        ok: true;
        id: string;
        status: "created" | "updated";
      }
    | { pageId: string; ok: false; error: string },
    { succeeded: number; failed: number }
  >();

  const items: PreviewItem[] = preview.data ?? [];
  const filteredItems = useMemo(
    () => filterNotionPreview(items, search, filter),
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
    [items, search, filter],
  );
  const visibleActionable = useMemo(
    () =>
      filteredItems.filter(
        (i) => i.status === "new" || i.status === "will-update",
      ),
    [filteredItems],
  );
  const allVisibleActionableSelected =
    visibleActionable.length > 0 &&
    visibleActionable.every((i) => selected.has(i.pageId));

  const toggle = useCallback((pageId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) => updateVisibleSelection(prev, visibleActionable));
  }, [visibleActionable]);

  const runImport = useCallback(async () => {
    const pageIds = [...selected];
    if (pageIds.length === 0) return;
    setImporting(true);
    setProgress({ done: 0, total: pageIds.length });
    for (const pageId of pageIds) {
      setResults((m) => new Map(m).set(pageId, { status: "importing" }));
    }
    // One streamed request: the server upserts each page (in its own tx) and does
    // a single batched recompute; per-page results + overall progress stream back.
    await startNotionImport(
      (signal) =>
        recipeStreams.importNotionSyncStream.open({ pageIds }, { signal }),
      {
        onItem: (item) =>
          setResults((m) =>
            new Map(m).set(
              item.pageId,
              item.ok
                ? { status: "done", id: item.id }
                : { status: "error", message: item.error },
            ),
          ),
        onProgress: (done, total) => setProgress({ done, total }),
        onDone: (r) => {
          // Refresh the recipe list + re-run the preview (flips new → will-update).
          if (r.succeeded > 0) {
            // `["recipe"]` also prefix-matches the preview's own
            // `["recipe","notionPreview"]`, which is what flips new →
            // will-update.
            void invalidateOperationTags(queryClient, ripple.recipe);
          }
        },
        successToast: (r) =>
          r.succeeded > 0
            ? `Imported ${r.succeeded} recipe${r.succeeded === 1 ? "" : "s"} from Notion`
            : null,
      },
    );
    setImporting(false);
    setProgress(null);
  }, [selected, startNotionImport, queryClient]);

  const summaryCounts = useMemo(() => {
    const c = { new: 0, update: 0, unchanged: 0, needs: 0 };
    for (const i of items) {
      if (i.status === "new") c.new++;
      else if (i.status === "will-update") c.update++;
      else if (i.status === "unchanged") c.unchanged++;
      else c.needs++;
    }
    return c;
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
  }, [items]);

  const summary = useMemo(() => {
    const parts: string[] = [];
    const c = summaryCounts;
    if (c.new) parts.push(`${c.new} new`);
    if (c.update) parts.push(`${c.update} to update`);
    if (c.unchanged) parts.push(`${c.unchanged} unchanged`);
    if (c.needs) parts.push(`${c.needs} need formatting`);
    return parts.join(" · ");
  }, [summaryCounts]);

  return (
    <Stack>
      <Row align="center" gap="sm">
        {preview.isSuccess && (
          <Description as="span">
            {items.length} recipe{items.length === 1 ? "" : "s"}
            {summary && ` · ${summary}`}
          </Description>
        )}
        <div className="flex-1" />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void preview.refetch()}
          disabled={preview.isFetching || importing}
        >
          <RotateCcw className="mr-1 size-3" />
          Refresh
        </Button>
        {items.length > 0 && (
          <Button
            type="button"
            size="sm"
            onClick={runImport}
            disabled={importing || selected.size === 0}
          >
            <Import className="mr-1 size-4" />
            Import {selected.size}
          </Button>
        )}
      </Row>

      {progress && <BulkProgressBar verb="Importing" progress={progress} />}

      {preview.isError && (
        <Row
          as="p"
          align="center"
          gap="xs"
          className="text-sm text-destructive"
        >
          <AlertCircle className="size-4" />
          {getErrorMessage(preview.error)}
        </Row>
      )}

      {preview.isFetching && items.length === 0 && (
        <Row
          as="p"
          align="center"
          gap="sm"
          className="text-sm text-muted-foreground"
        >
          <Spinner className="size-4" /> Reading the Notion Recipes database…
        </Row>
      )}

      {items.length > 0 && (
        <Card size="sm">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Checkbox
              aria-label="Select all visible new and changed recipes"
              checked={allVisibleActionableSelected}
              disabled={visibleActionable.length === 0}
              onCheckedChange={toggleAll}
            />
            <Row wrap align="center" gap="sm" className="min-w-0 flex-1">
              <Description as="span">
                Select visible new &amp; changed ({visibleActionable.length})
              </Description>
              <div className="relative min-w-40 flex-1 sm:max-w-xs">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search recipes"
                  aria-label="Search Notion recipes"
                  className="pl-8"
                />
              </div>
              <NativeSelect
                value={filter}
                onChange={(event) => {
                  const nextFilter = [
                    "all",
                    "new",
                    "will-update",
                    "unchanged",
                    "needs-formatting",
                  ].find(
                    (candidate): candidate is NotionPreviewFilter =>
                      candidate === event.target.value,
                  );
                  if (nextFilter) setFilter(nextFilter);
                }}
                aria-label="Filter Notion recipes by status"
              >
                <option value="all">All ({items.length})</option>
                <option value="new">New ({summaryCounts.new})</option>
                <option value="will-update">
                  Update ({summaryCounts.update})
                </option>
                <option value="unchanged">
                  Unchanged ({summaryCounts.unchanged})
                </option>
                <option value="needs-formatting">
                  Needs formatting ({summaryCounts.needs})
                </option>
              </NativeSelect>
            </Row>
          </CardHeader>
          <CardContent>
            {filteredItems.length > 0 ? (
              <NotionRecipeList
                items={filteredItems}
                selected={selected}
                results={results}
                onToggle={toggle}
              />
            ) : (
              <Description className="py-4 text-center" size="xs">
                No recipes match this search and status filter.
              </Description>
            )}
          </CardContent>
        </Card>
      )}
    </Stack>
  );
}

function NotionRecipeList({
  items,
  selected,
  results,
  onToggle,
}: {
  items: PreviewItem[];
  selected: ReadonlySet<string>;
  results: ReadonlyMap<string, ImportResult>;
  onToggle: (pageId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 360,
    getItemKey: (index) => items[index]!.pageId,
    overscan: 4,
  });

  return (
    <div ref={scrollRef} className="max-h-[70vh] overflow-auto">
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const item = items[virtualItem.index]!;
          return (
            <div
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full pb-2"
              style={{ transform: `translateY(${virtualItem.start}px)` }}
            >
              <RecipeImportCard
                recipe={item.recipe}
                status={item.status}
                existingId={item.existingId ?? undefined}
                reasons={item.reasons}
                selected={selected.has(item.pageId)}
                disabled={item.status === "needs-formatting"}
                onToggle={() => onToggle(item.pageId)}
                result={results.get(item.pageId)}
                externalUrl={item.notionUrl}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
