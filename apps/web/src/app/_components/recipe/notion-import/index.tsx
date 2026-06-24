import type { ImportRecipe } from "@cubby/schemas/import-recipe";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Import } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useBulkStream } from "~/app/_components/hooks/useBulkStream";
import { BulkProgressBar } from "~/components/ui/bulk-progress-bar";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Spinner } from "~/components/ui/spinner";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC, useTRPCClient } from "~/trpc/react";
import type { ImportResult } from "../cookbook-import/types";
import { RecipeImportCard } from "../recipe-import-card";

type PreviewItem = {
  pageId: string;
  name: string;
  notionUrl: string;
  status: "new" | "unchanged" | "will-update" | "needs-formatting";
  existingId: string | null;
  reasons: string[];
  recipe: ImportRecipe;
};

/**
 * Import recipes from the Notion "Recipes" database. Mirrors the cookbook
 * importer's preview-then-commit flow, minus the EPUB acquisition phase: the
 * preview auto-loads on mount (parsing every row server-side), the list (the
 * shared {@link RecipeImportCard}) lets you pick a subset (non-conforming rows
 * are disabled with reasons), and a per-recipe loop commits with live status.
 * Re-import is keyed on the Notion page id.
 */
export function NotionImport() {
  const api = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, ImportResult>>(new Map());
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  // Auto-loads on mount: reading the Notion Recipes DB is the whole point of the
  // page, so there's no reason to gate it behind a click. staleTime: 0 means every
  // visit (refresh or in-app nav) refetches the current Notion state, which is what
  // a refresh button would have done — so we don't need one.
  const preview = useQuery(
    api.recipe.previewNotionSync.queryOptions(undefined, { staleTime: 0 }),
  );
  // Per-page outcome streamed back from importNotionSyncStream, keyed by page id.
  const { start: startNotionImport } = useBulkStream<
    | { pageId: string; ok: true; id: string; status: "created" | "updated" }
    | { pageId: string; ok: false; error: string },
    { succeeded: number; failed: number }
  >();

  const items = (preview.data ?? []) as PreviewItem[];
  // Checkbox is enabled for anything that isn't malformed (incl. unchanged, in
  // case you want to force a re-import); "select all" only ticks the actionable
  // ones (new + will-update) since re-importing an unchanged recipe is a no-op.
  const actionable = useMemo(
    () => items.filter((i) => i.status === "new" || i.status === "will-update"),
    [items],
  );
  const allActionableSelected =
    actionable.length > 0 && actionable.every((i) => selected.has(i.pageId));

  const toggle = useCallback((pageId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      actionable.every((i) => prev.has(i.pageId))
        ? new Set()
        : new Set(actionable.map((i) => i.pageId)),
    );
  }, [actionable]);

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
      () => client.recipe.importNotionSyncStream.mutate({ pageIds }),
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
            void queryClient.invalidateQueries({
              queryKey: [queryKeys.recipe.all],
            });
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
  }, [selected, client, startNotionImport, queryClient]);

  const summary = useMemo(() => {
    const c = { new: 0, update: 0, unchanged: 0, needs: 0 };
    for (const i of items) {
      if (i.status === "new") c.new++;
      else if (i.status === "will-update") c.update++;
      else if (i.status === "unchanged") c.unchanged++;
      else c.needs++;
    }
    const parts: string[] = [];
    if (c.new) parts.push(`${c.new} new`);
    if (c.update) parts.push(`${c.update} to update`);
    if (c.unchanged) parts.push(`${c.unchanged} unchanged`);
    if (c.needs) parts.push(`${c.needs} need formatting`);
    return parts.join(" · ");
  }, [items]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {preview.isSuccess && (
          <span className="text-muted-foreground text-sm">
            {items.length} recipe{items.length === 1 ? "" : "s"}
            {summary && ` · ${summary}`}
          </span>
        )}
        <div className="flex-1" />
        {items.length > 0 && (
          <Button
            type="button"
            size="sm"
            onClick={runImport}
            disabled={importing || selected.size === 0}
          >
            <Import className="mr-1 h-4 w-4" />
            Import {selected.size}
          </Button>
        )}
      </div>

      {progress && <BulkProgressBar verb="Importing" progress={progress} />}

      {preview.isError && (
        <p className="flex items-center gap-1 text-destructive text-sm">
          <AlertCircle className="h-4 w-4" />
          {getErrorMessage(preview.error)}
        </p>
      )}

      {preview.isFetching && items.length === 0 && (
        <p className="flex items-center gap-2 text-muted-foreground text-sm">
          <Spinner className="h-4 w-4" /> Reading the Notion Recipes database…
        </p>
      )}

      {items.length > 0 && (
        <Card size="sm">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Checkbox
              aria-label="Select all new and changed"
              checked={allActionableSelected}
              disabled={actionable.length === 0}
              onCheckedChange={toggleAll}
            />
            <span className="text-muted-foreground text-sm">
              Select all new &amp; changed ({actionable.length})
            </span>
          </CardHeader>
          <CardContent className="space-y-2">
            {items.map((item) => (
              <RecipeImportCard
                key={item.pageId}
                recipe={item.recipe}
                status={item.status}
                existingId={item.existingId ?? undefined}
                reasons={item.reasons}
                selected={selected.has(item.pageId)}
                disabled={item.status === "needs-formatting"}
                onToggle={() => toggle(item.pageId)}
                result={results.get(item.pageId)}
                externalUrl={item.notionUrl}
              />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
