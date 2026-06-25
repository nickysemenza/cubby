import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useBulkActionMutation } from "~/app/_components/hooks/useBulkActionMutation";
import { MergeConfirmation } from "~/app/_components/ingredient/merge-confirmation";
import { Row, Stack } from "~/components/layout";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription } from "~/components/ui/empty";
import { Progress } from "~/components/ui/progress";
import { Spinner } from "~/components/ui/spinner";
import { StatusText } from "~/components/ui/status-text";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { getErrorMessage } from "~/lib/error-utils";
import { queryKeys } from "~/lib/query-keys";
import { savedWithRecompute } from "~/lib/recompute-summary";
import { cn } from "~/lib/utils";
import { useTRPC } from "~/trpc/react";
import { ReviewQueue } from "./review-queue";
import { SuggestionReviewTray } from "./suggestion-review-tray";
import {
  buildPackagePrice,
  hasUsdaLink,
  isCookbookOnly,
} from "./workbench-editor-core";
import { type Suggestion, WorkbenchRow } from "./workbench-row";

type FilterKey = "all" | "no-product" | "partial" | "no-usda";

/**
 * Dense bulk-enrichment table for ingredients that can't be fully costed yet —
 * the bare ones EPUB imports leave behind (no product) plus those with a product
 * whose conversion graph is still incomplete. Each row shows its coverage and the
 * single recommended fix, and expands inline to link a USDA food, set a price,
 * and add conversions. Select rows to run AI USDA suggestions and create products
 * in bulk, or mark "no USDA exists" — without the modal-per-ingredient grind.
 */
export function EnrichmentWorkbench({ focus }: { focus?: string }) {
  const api = useTRPC();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [view, setView] = useState<"browse" | "review">("browse");
  // Layered on top of the chips: drop ingredients used only in imported cookbook
  // recipes (the long noise tail) from counts + the visible/review set.
  const [hideCookbookOnly, setHideCookbookOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [suggestions, setSuggestions] = useState<Record<string, Suggestion>>(
    {},
  );
  // Optional package price typed per suggestion in the review tray, so bulk
  // create can land a fully-costable product (fdc_id covers weight/volume/cal
  // via synthesis; price is the only thing create can't infer).
  const [suggestionPrices, setSuggestionPrices] = useState<
    Record<string, { dollars: string; qty: string; unit: string }>
  >({});
  // The order of ids sent to the last createMany, so its index-keyed failures
  // map back to rows (the hook's onSuccess doesn't see the variables).
  const createOrderRef = useRef<string[]>([]);
  const [mergeSuggestions, setMergeSuggestions] = useState<
    Record<string, { targetId: string; targetName: string }>
  >({});
  // The ingredient pair awaiting a merge — fed to the shared MergeConfirmation,
  // which lets the user pick the keeper (the candidate is listed first, so it's
  // the default target). `mergeTargetRef` mirrors that choice for onExecute.
  const [mergeConfirm, setMergeConfirm] = useState<
    { id: string; name: string }[] | null
  >(null);
  const mergeTargetRef = useRef<string | null>(null);

  const { data, isLoading, error } = useQuery(
    api.ingredient.enrichmentWorkbench.queryOptions(),
  );

  const rows = useMemo(() => data ?? [], [data]);

  // Arriving from a Problems "Fix in workbench" link: scroll the targeted
  // ingredient's row into view once the data loads (it auto-expands via
  // WorkbenchRow's defaultOpen). `focus` stays on the default "all" filter so the
  // row is never filtered out.
  const focusRowRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    if (!focus || isLoading) return;
    // The worklist is recipe-used ingredients that aren't fully costable yet, so
    // a focus target can be absent (e.g. a partial-coverage product whose
    // ingredient isn't in any recipe). Say so rather than silently doing nothing.
    if (!rows.some((r) => r.id === focus)) {
      toast.info("That ingredient isn't in the workbench worklist.");
      return;
    }
    focusRowRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [focus, rows, isLoading]);

  const cookbookOnlyCount = useMemo(
    () => rows.filter((r) => isCookbookOnly(r)).length,
    [rows],
  );

  // The set the chips count + filter against — the cookbook toggle reduces it so
  // the chip counts stay honest about what's actually shown.
  const base = useMemo(
    () => (hideCookbookOnly ? rows.filter((r) => !isCookbookOnly(r)) : rows),
    [rows, hideCookbookOnly],
  );

  const counts = useMemo(
    () => ({
      all: base.length,
      "no-product": base.filter((r) => r.recommendedFix === "no-product")
        .length,
      partial: base.filter((r) => r.recommendedFix !== "no-product").length,
      "no-usda": base.filter((r) => !hasUsdaLink(r)).length,
    }),
    [base],
  );

  const visible = useMemo(
    () =>
      match(filter)
        .with("all", () => base)
        .with("no-product", () =>
          base.filter((r) => r.recommendedFix === "no-product"),
        )
        .with("partial", () =>
          base.filter((r) => r.recommendedFix !== "no-product"),
        )
        .with("no-usda", () => base.filter((r) => !hasUsdaLink(r)))
        .exhaustive(),
    [base, filter],
  );

  const selectedRows = useMemo(
    () => rows.filter((r) => selected.has(r.id)),
    [rows, selected],
  );

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const clearSelection = () => setSelected(new Set());

  const suggestUsda = useMutation(
    api.ai.suggestUsdaFoodBatch.mutationOptions(),
  );
  const createMany = useBulkActionMutation({
    run: (
      client,
      vars: Parameters<typeof client.product.createMany.mutate>[0],
    ) => client.product.createMany.mutate(vars),
    success: (data) =>
      data.failed.length === 0
        ? `Created ${data.created} product${data.created === 1 ? "" : "s"}.`
        : `Created ${data.created}, ${data.failed.length} failed.`,
    invalidateKeys: [queryKeys.ingredient.all, queryKeys.product.all],
    onSuccess: (data) => {
      // Drop only the suggestions that actually created; keep failed rows (and
      // their selection) so they can be retried without re-suggesting.
      const failedIdx = new Set(data.failed.map((f) => f.index));
      const succeeded = createOrderRef.current.filter(
        (_, i) => !failedIdx.has(i),
      );
      const failed = new Set(
        createOrderRef.current.filter((_, i) => failedIdx.has(i)),
      );
      setSuggestions((prev) => {
        const next = { ...prev };
        for (const id of succeeded) delete next[id];
        return next;
      });
      setSuggestionPrices((prev) => {
        const next = { ...prev };
        for (const id of succeeded) delete next[id];
        return next;
      });
      setSelected(failed);
      for (const f of data.failed) {
        toast.error(`${f.name}: ${f.error}`);
      }
    },
    error: (err) => `Create failed: ${getErrorMessage(err)}`,
  });
  const markNoUsda = useBulkActionMutation({
    run: (
      client,
      vars: Parameters<typeof client.product.markUsdaUnavailableMany.mutate>[0],
    ) => client.product.markUsdaUnavailableMany.mutate(vars),
    success: "Marked: no USDA entry.",
    invalidateKeys: [queryKeys.ingredient.all, queryKeys.product.all],
    onSuccess: clearSelection,
    error: (err) => `Failed: ${getErrorMessage(err)}`,
  });
  const suggestMerges = useMutation(
    api.ai.suggestIngredientMergeBatch.mutationOptions(),
  );
  const mergeMutation = useActionMutation({
    mutationFn: api.ingredient.merge.mutationOptions,
    success: (data) => savedWithRecompute(data.sideEffects, "Merged"),
    invalidateKeys: [queryKeys.ingredient.all, queryKeys.recipe.all],
    error: (err) => `Merge failed: ${getErrorMessage(err)}`,
  });

  const handleSuggestMerges = async () => {
    const ingredients = selectedRows.map((r) => ({ id: r.id, name: r.name }));
    if (ingredients.length === 0) return;
    try {
      const results = await suggestMerges.mutateAsync({ ingredients });
      const next: Record<string, { targetId: string; targetName: string }> = {};
      let matched = 0;
      for (const r of results) {
        if (r.target) {
          next[r.source.id] = {
            targetId: r.target.id,
            targetName: r.target.name,
          };
          matched++;
        }
      }
      setMergeSuggestions((prev) => ({ ...prev, ...next }));
      toast.success(`AI found ${matched} merge${matched === 1 ? "" : "s"}.`);
    } catch (err) {
      toast.error(`Merge suggestion failed: ${getErrorMessage(err)}`);
    }
  };

  // Open the shared merge confirmation for a pair. Merge candidates are
  // suggestions — the AI ones and especially the trigram ones have false
  // positives (e.g. "red wine vinegar" ~ "white wine vinegar") — so the user
  // confirms and picks the keeper. The candidate goes first so it's the default
  // target (it's the one likelier to already have a product/enrichment).
  const requestMerge = (pair: {
    source: { id: string; name: string };
    target: { id: string; name: string };
  }) => setMergeConfirm([pair.target, pair.source]);

  // Execute the merge the user confirmed: keeper = the chosen target, the other
  // becomes an alias (deleted, its recipe lines + products repoint to the keeper).
  const confirmMerge = () => {
    const pair = mergeConfirm;
    if (!pair || pair.length < 2) return;
    const target =
      pair.find((i) => i.id === mergeTargetRef.current) ?? pair[0]!;
    const alias = pair.find((i) => i.id !== target.id);
    if (!alias) return;
    mergeMutation.mutate({ target: target.id, aliases: [alias.id] });
    setMergeSuggestions((prev) => {
      const next = { ...prev };
      delete next[alias.id];
      return next;
    });
    setMergeConfirm(null);
  };

  const handleSuggest = async () => {
    const names = selectedRows.map((r) => r.name);
    if (names.length === 0) return;
    const byName = new Map(
      selectedRows.map((r) => [r.name.toLowerCase(), r.id]),
    );
    try {
      const results = await suggestUsda.mutateAsync({ ingredientNames: names });
      const next: Record<string, Suggestion> = {};
      let matched = 0;
      for (const r of results) {
        const id = byName.get(r.name.toLowerCase());
        if (id && r.food) {
          next[id] = {
            food: r.food,
            confidence: r.confidence,
            reasoning: r.reasoning,
          };
          matched++;
        }
      }
      setSuggestions((prev) => ({ ...prev, ...next }));
      toast.success(`AI matched ${matched}/${names.length}.`);
    } catch (err) {
      toast.error(`Suggestion failed: ${getErrorMessage(err)}`);
    }
  };

  const creatable = selectedRows.filter(
    (r) => r.product.length === 0 && suggestions[r.id],
  );
  const handleCreate = () => {
    if (creatable.length === 0) {
      toast.error("No selected rows have an AI suggestion yet. Suggest first.");
      return;
    }
    createOrderRef.current = creatable.map((r) => r.id);
    createMany.mutate(
      creatable.map((r) => {
        const p = suggestionPrices[r.id];
        const { eachPrice, mapping } = p
          ? buildPackagePrice(p.dollars, p.qty, p.unit)
          : { eachPrice: null, mapping: null };
        return {
          name: r.name,
          manufacturer: UNSPECIFIED_MANUFACTURER,
          upc: null,
          expectedQuantity: null,
          ingredientId: r.id,
          fdc_id: suggestions[r.id]!.food.fdc_id,
          // Ingredient products are food — keeps the category-clean invariant
          // (the synthesized weight/volume/calorie edges come from the fdc link).
          category: "food" as const,
          price: eachPrice,
          unitMappings: mapping ? [mapping] : [],
        };
      }),
    );
  };

  const rejectSuggestion = (id: string) => {
    setSuggestions((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSuggestionPrices((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const setSuggestionPrice = (
    id: string,
    patch: Partial<{ dollars: string; qty: string; unit: string }>,
  ) =>
    setSuggestionPrices((prev) => ({
      ...prev,
      [id]: { dollars: "", qty: "1", unit: "lb", ...prev[id], ...patch },
    }));

  const suggestionCount = Object.keys(suggestions).length;

  const markable = selectedRows.flatMap((r) =>
    r.product.length > 0 && !hasUsdaLink(r) ? [r.product[0]!.id] : [],
  );
  const handleMarkNoUsda = () => {
    if (markable.length === 0) {
      toast.error("No selected rows have a product missing a USDA link.");
      return;
    }
    markNoUsda.mutate({ ids: markable });
  };

  return (
    <Stack>
      <Row align="center" wrap gap="sm">
        {(
          [
            ["all", "All"],
            ["no-product", "No product"],
            ["partial", "Partial"],
            ["no-usda", "No USDA"],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            onClick={() => setFilter(key)}
            className={cn(
              "rounded-md px-2 py-1 text-sm transition-colors",
              filter === key
                ? "bg-secondary font-medium"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {label} {counts[key]}
          </button>
        ))}
        {cookbookOnlyCount > 0 && (
          <button
            type="button"
            onClick={() => setHideCookbookOnly((v) => !v)}
            aria-pressed={hideCookbookOnly}
            className={cn(
              "rounded-md px-2 py-1 text-sm transition-colors",
              hideCookbookOnly
                ? "bg-secondary font-medium"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            Hide cookbook-only ({cookbookOnlyCount})
          </button>
        )}
        <Row align="center" gap="xs" className="ml-auto">
          {(["browse", "review"] as const).map((v) => (
            <Button
              key={v}
              type="button"
              size="sm"
              variant={view === v ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs capitalize"
              onClick={() => setView(v)}
            >
              {v}
            </Button>
          ))}
        </Row>
      </Row>

      {view === "review" && (
        <ReviewQueue rows={visible} onExit={() => setView("browse")} />
      )}

      {view === "browse" && (
        <>
          {suggestionCount > 0 && (
            <SuggestionReviewTray
              rows={rows}
              suggestions={suggestions}
              suggestionPrices={suggestionPrices}
              creatableCount={creatable.length}
              isPending={createMany.isPending}
              progress={createMany.progress}
              onCreate={handleCreate}
              onReject={rejectSuggestion}
              onPriceChange={setSuggestionPrice}
            />
          )}

          {error && (
            <StatusText as="div" tone="destructive" className="text-sm">
              {error.message}
            </StatusText>
          )}

          {!isLoading && rows.length === 0 && (
            <Empty>
              <EmptyDescription>
                Every recipe ingredient is fully costable. Nothing to enrich.
              </EmptyDescription>
            </Empty>
          )}

          {visible.length > 0 && (
            <Table
              className="table-auto"
              containerClassName="overflow-hidden rounded-lg border border-[var(--border)]"
            >
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead className="w-8" />
                  <TableHead>Ingredient</TableHead>
                  <TableHead>Coverage</TableHead>
                  <TableHead>Next</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((row) => (
                  <WorkbenchRow
                    key={row.id}
                    row={row}
                    selected={selected.has(row.id)}
                    onToggle={() => toggle(row.id)}
                    suggestion={suggestions[row.id] ?? null}
                    mergeSuggestion={mergeSuggestions[row.id] ?? null}
                    onRequestMerge={requestMerge}
                    defaultOpen={row.id === focus}
                    rowRef={row.id === focus ? focusRowRef : undefined}
                  />
                ))}
              </TableBody>
            </Table>
          )}

          {isLoading && (
            <Row justify="center" className="py-6">
              <Spinner />
            </Row>
          )}

          {selected.size > 0 && (
            <Row
              align="center"
              wrap
              gap="sm"
              className="sticky bottom-4 rounded-lg border border-[var(--border)] bg-background/95 px-4 py-2 shadow-sm backdrop-blur"
            >
              <span className="font-medium text-sm">
                {selected.size} selected
              </span>
              <span className="text-border">|</span>
              <Button
                size="sm"
                variant="outline"
                onClick={handleSuggest}
                disabled={suggestUsda.isPending}
              >
                <Sparkles className="h-4 w-4" />
                {suggestUsda.isPending ? "Suggesting…" : "Suggest USDA"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleSuggestMerges}
                disabled={suggestMerges.isPending}
              >
                <Sparkles className="h-4 w-4" />
                {suggestMerges.isPending ? "Checking…" : "Suggest merges"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleMarkNoUsda}
                disabled={markNoUsda.isPending || markable.length === 0}
              >
                Mark no-USDA ({markable.length})
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSelection}>
                Clear
              </Button>
              {markNoUsda.progress && (
                <Progress
                  className="w-full"
                  value={markNoUsda.progress.done}
                  max={markNoUsda.progress.total}
                />
              )}
            </Row>
          )}

          <AlertDialog
            open={mergeConfirm != null}
            onOpenChange={(o) => {
              if (!o) setMergeConfirm(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Merge ingredients?</AlertDialogTitle>
              </AlertDialogHeader>
              {mergeConfirm && (
                <MergeConfirmation
                  ingredients={mergeConfirm}
                  targetRef={mergeTargetRef}
                />
              )}
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={mergeMutation.isPending}
                  onClick={confirmMerge}
                >
                  Merge
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </Stack>
  );
}
