import type { Confidence } from "@cubby/schemas/ai";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitMerge,
  Sparkles,
  X,
} from "lucide-react";
import { type Ref, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import { confidenceColor } from "~/app/_components/ai/ai-suggest";
import { UsdaFoodSearchField } from "~/app/_components/combobox/with-usda-food-search";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useBulkActionMutation } from "~/app/_components/hooks/useBulkActionMutation";
import { MergeConfirmation } from "~/app/_components/ingredient/merge-confirmation";
import { RecipeUsagesTable } from "~/app/_components/recipe/recipe-usages-table";
import { CoverageChips } from "~/app/problems/components/unit-coverage-fix";
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
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Description } from "~/components/ui/description";
import { Empty, EmptyDescription } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Progress } from "~/components/ui/progress";
import { Spinner } from "~/components/ui/spinner";
import { StatusText } from "~/components/ui/status-text";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithRecompute } from "~/lib/recompute-summary";
import { cn } from "~/lib/utils";
import type { EnrichmentRow } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import { EnrichmentEditor } from "./enrichment-editor";
import { ReviewQueue } from "./review-queue";
import {
  buildPackagePrice,
  hasPriceEntry,
  hasUsdaLink,
  isCookbookOnly,
  UnitInput,
} from "./workbench-editor-core";

type FilterKey = "all" | "no-product" | "partial" | "no-usda";

/** An AI USDA suggestion for one row, kept at the table level for bulk review. */
type Suggestion = {
  food: FoodSummaryWithLinkedProducts;
  confidence: Confidence;
  reasoning: string;
};

const FIX_LABEL: Record<EnrichmentRow["recommendedFix"], string> = {
  "no-product": "Link product",
  "link-usda": "Link USDA",
  "set-per-item-price": "Set price",
  "add-purchase-mapping": "Set price",
  "add-weight-mapping": "Add weight",
  "add-volume-mapping": "Add volume",
  done: "Done",
};

// The "Next" badge label. A priced-but-money-uncovered row is islanded — the fix
// is to connect the existing price, not set a new one, so say so.
const fixBadgeLabel = (row: EnrichmentRow): string => {
  if (
    !row.coverage.covered.includes("money") &&
    hasPriceEntry(row) &&
    (row.recommendedFix === "set-per-item-price" ||
      row.recommendedFix === "add-purchase-mapping" ||
      row.recommendedFix === "add-weight-mapping")
  ) {
    return "Connect price";
  }
  return FIX_LABEL[row.recommendedFix];
};

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
    invalidateKeys: [["ingredient"], ["product"]],
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
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: clearSelection,
    error: (err) => `Failed: ${getErrorMessage(err)}`,
  });
  const suggestMerges = useMutation(
    api.ai.suggestIngredientMergeBatch.mutationOptions(),
  );
  const mergeMutation = useActionMutation({
    mutationFn: api.ingredient.merge.mutationOptions,
    success: (data) => savedWithRecompute(data.sideEffects, "Merged"),
    invalidateKeys: [["ingredient"], ["recipe"]],
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
            <Stack
              gap="sm"
              className="rounded-lg border border-[var(--border-chunky)] bg-muted/20 p-4"
            >
              <Row align="center" justify="between" gap="sm">
                <span className="font-medium text-sm">
                  Review {suggestionCount} USDA suggestion
                  {suggestionCount === 1 ? "" : "s"}
                </span>
                <Button
                  size="sm"
                  onClick={handleCreate}
                  disabled={createMany.isPending || creatable.length === 0}
                >
                  Create {creatable.length} product
                  {creatable.length === 1 ? "" : "s"}
                </Button>
              </Row>
              {createMany.progress && (
                <Progress
                  value={createMany.progress.done}
                  max={createMany.progress.total}
                />
              )}
              <Stack gap="sm">
                {Object.entries(suggestions).map(([id, sug]) => {
                  const row = rows.find((r) => r.id === id);
                  if (!row) return null;
                  const p = suggestionPrices[id] ?? {
                    dollars: "",
                    qty: "1",
                    unit: "lb",
                  };
                  return (
                    <Row
                      key={id}
                      align="center"
                      wrap
                      gap="sm"
                      className="text-sm"
                    >
                      <button
                        type="button"
                        onClick={() => rejectSuggestion(id)}
                        aria-label={`Reject suggestion for ${row.name}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-4 w-4" />
                      </button>
                      <span className="font-medium">{row.name}</span>
                      <span className="truncate text-muted-foreground">
                        → {sug.food.foodInfo.description}
                      </span>
                      <span
                        className={cn(
                          "text-2xs",
                          confidenceColor[sug.confidence],
                        )}
                        title={sug.reasoning}
                      >
                        {sug.confidence}
                      </span>
                      <Row
                        as="span"
                        align="center"
                        gap="xs"
                        className="ml-auto text-xs"
                      >
                        <span className="text-muted-foreground">$</span>
                        <Input
                          value={p.dollars}
                          onChange={(e) =>
                            setSuggestionPrice(id, { dollars: e.target.value })
                          }
                          placeholder="price"
                          aria-label={`Price for ${row.name}`}
                          className="h-7 w-16"
                        />
                        <span className="text-muted-foreground">/</span>
                        <Input
                          value={p.qty}
                          onChange={(e) =>
                            setSuggestionPrice(id, { qty: e.target.value })
                          }
                          aria-label={`Price quantity for ${row.name}`}
                          className="h-7 w-12"
                        />
                        <UnitInput
                          value={p.unit}
                          onChange={(v) => setSuggestionPrice(id, { unit: v })}
                          ariaLabel={`Price unit for ${row.name}`}
                        />
                      </Row>
                    </Row>
                  );
                })}
              </Stack>
              <Description size="2xs">
                Price optional — leave blank to create the USDA link and price
                later. Foods are usually priced by package (e.g. $5.99 / 2 lb);
                a unit of “each” stores a per-item price.
              </Description>
            </Stack>
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
              containerClassName="overflow-hidden rounded-lg border border-[var(--border-chunky)]"
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
              className="sticky bottom-4 rounded-lg border border-[var(--border-chunky)] bg-background/95 px-4 py-2 shadow-sm backdrop-blur"
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

/** Inline "≈ candidate · Merge" hint shown under an ingredient name. */
function MergeHint({
  tone,
  targetName,
  onMerge,
}: {
  tone: "ai" | "fuzzy";
  targetName: string;
  onMerge: () => void;
}) {
  return (
    <Row align="center" gap="sm" className="mt-1">
      <span
        className={cn(
          "text-xs",
          tone === "ai" ? "text-info" : "text-muted-foreground",
        )}
      >
        {tone === "ai" ? "≈" : "possible dup:"} {targetName}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-6 px-2 text-xs"
        onClick={(e) => {
          e.stopPropagation();
          onMerge();
        }}
      >
        <GitMerge className="h-3 w-3" />
        Merge
      </Button>
    </Row>
  );
}

function WorkbenchRow({
  row,
  selected,
  onToggle,
  suggestion,
  mergeSuggestion,
  onRequestMerge,
  defaultOpen = false,
  rowRef,
}: {
  row: EnrichmentRow;
  selected: boolean;
  onToggle: () => void;
  suggestion: Suggestion | null;
  mergeSuggestion: { targetId: string; targetName: string } | null;
  onRequestMerge: (pair: {
    source: { id: string; name: string };
    target: { id: string; name: string };
  }) => void;
  /** Start expanded (deep-link focus from the Problems page). */
  defaultOpen?: boolean;
  /** Ref on the row's first <tr>, so the parent can scroll it into view. */
  rowRef?: Ref<HTMLTableRowElement>;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <>
      <TableRow
        ref={rowRef}
        className={cn(
          "cursor-pointer hover:bg-accent/40",
          (open || selected) && "bg-accent/30",
        )}
        onClick={(e) => {
          // Don't toggle the row when the click came from the checkbox, the
          // merge button, or any other interactive control inside it.
          if (
            (e.target as HTMLElement).closest(
              'button, input, a, [role="checkbox"]',
            )
          ) {
            return;
          }
          setOpen((v) => !v);
        }}
      >
        <TableCell>
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            aria-label={`Select ${row.name}`}
          />
        </TableCell>
        <TableCell className="text-muted-foreground">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </TableCell>
        <TableCell className="whitespace-normal">
          <div className="font-medium">{row.name}</div>
          <div className="text-muted-foreground text-xs">
            × {row.recipeCount} recipe{row.recipeCount === 1 ? "" : "s"}
            {suggestion && (
              <span className="ml-2 text-info">
                · AI: {suggestion.food.foodInfo.description}{" "}
                <span className={confidenceColor[suggestion.confidence]}>
                  ({suggestion.confidence})
                </span>
              </span>
            )}
          </div>
          {mergeSuggestion ? (
            <MergeHint
              tone="ai"
              targetName={mergeSuggestion.targetName}
              onMerge={() =>
                onRequestMerge({
                  source: { id: row.id, name: row.name },
                  target: {
                    id: mergeSuggestion.targetId,
                    name: mergeSuggestion.targetName,
                  },
                })
              }
            />
          ) : (
            // Tier-1/2 trigram near-dup hint — no AI call needed. Suggestion only;
            // the confirm dialog guards against false positives.
            row.mergeCandidates[0] && (
              <MergeHint
                tone="fuzzy"
                targetName={row.mergeCandidates[0].name}
                onMerge={() => {
                  const cand = row.mergeCandidates[0];
                  if (cand)
                    onRequestMerge({
                      source: { id: row.id, name: row.name },
                      target: { id: cand.id, name: cand.name },
                    });
                }}
              />
            )
          )}
        </TableCell>
        <TableCell>
          <CoverageChips
            covered={row.coverage.covered}
            applicable={row.coverage.applicable}
          />
        </TableCell>
        <TableCell>
          <Badge variant="outline" className="font-normal">
            {fixBadgeLabel(row)}
          </Badge>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/20">
          <TableCell />
          <TableCell />
          <TableCell colSpan={3} className="whitespace-normal pr-4">
            <WorkbenchEditor
              row={row}
              initialFood={suggestion?.food ?? null}
              onDone={() => setOpen(false)}
            />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/**
 * Browse-table chrome around the shared {@link EnrichmentEditor}: a plain USDA
 * search picker, Save/Cancel, and the recipe-usages footer. All the gap-aware
 * editing (link/price/conversions/N-A + live graph) lives in EnrichmentEditor,
 * shared with the review card so the two can't drift.
 */
function WorkbenchEditor({
  row,
  initialFood,
  onDone,
}: {
  row: EnrichmentRow;
  initialFood: FoodSummaryWithLinkedProducts | null;
  onDone: () => void;
}) {
  const api = useTRPC();
  const product = row.product[0] ?? null;

  // Recipe usages are fetched lazily (this editor mounts only when the row is
  // expanded) so the worklist query stays lean — it no longer ships every usage's
  // recipe body per row.
  const usages = useQuery(
    api.ingredient.recipeUsages.queryOptions({ id: row.id }),
  );

  return (
    <EnrichmentEditor
      row={row}
      initialFood={initialFood}
      onSaved={onDone}
      slots={{
        usdaPicker: ({ food, setFood }) => (
          <>
            <UsdaFoodSearchField
              initialQuery={row.name}
              label=""
              onSelect={setFood}
            />
            {food && (
              <Row
                as="p"
                align="center"
                gap="xs"
                className="text-positive text-xs"
              >
                <Check className="h-3 w-3" />
                {food.foodInfo.description}
              </Row>
            )}
          </>
        ),
        actions: ({ save, isPending }) => (
          <Row align="center" gap="sm">
            <Button size="sm" onClick={save} disabled={isPending}>
              {isPending
                ? "Saving…"
                : product == null
                  ? "Create product"
                  : "Save"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDone}>
              Cancel
            </Button>
          </Row>
        ),
        footer:
          row.recipeCount > 0 ? (
            <Stack gap="sm">
              <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
                Appears in {row.recipeCount} recipe
                {row.recipeCount === 1 ? "" : "s"}
              </p>
              {usages.data && usages.data.length > 0 ? (
                <div className="overflow-x-auto rounded-md border border-[var(--border-chunky)] bg-background/60 p-2">
                  <RecipeUsagesTable
                    usages={usages.data}
                    ingredientName={row.name}
                    aliases={row.aliases}
                  />
                </div>
              ) : (
                <p className="text-muted-foreground text-xs">
                  {usages.isLoading ? "Loading usages…" : "No live usages."}
                </p>
              )}
            </Stack>
          ) : null,
      }}
    />
  );
}
