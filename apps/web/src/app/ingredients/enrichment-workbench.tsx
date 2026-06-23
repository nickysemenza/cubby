import type { Confidence } from "@cubby/schemas/ai";
import type { FoodSummaryWithLinkedProducts } from "@cubby/schemas/combo";
import type { UnitMapping, UnitMappingInput } from "@cubby/schemas/unitmapping";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  GitMerge,
  Plus,
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
import { ConversionCapabilities } from "~/app/_components/units/ConversionCapabilities";
import {
  isDisplayMapping,
  UnitMappingGraph,
} from "~/app/_components/units/unit-mapping-graph";
import { UnitMappingsTable } from "~/app/_components/units/unitmappingstable";
import { CoverageChips } from "~/app/problems/components/unit-coverage-fix";
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
import { Input } from "~/components/ui/input";
import { Progress } from "~/components/ui/progress";
import { Spinner } from "~/components/ui/spinner";
import { BASE_KINDS, type BaseKind } from "~/lib/conversion-coverage";
import { getErrorMessage } from "~/lib/error-utils";
import { isMoneyUnit } from "~/lib/price-mapping-utils";
import { savedWithRecompute } from "~/lib/recompute-summary";
import { getIngredientMappings } from "~/lib/unit-mapping-utils";
import { cn } from "~/lib/utils";
import type { EnrichmentRow } from "~/server/services/ingredient.service";
import { useTRPC } from "~/trpc/react";
import { ReviewQueue } from "./review-queue";
import {
  buildPackagePrice,
  buildPreviewMappings,
  buildProductWrite,
  defaultPriceUnit,
  hasPriceEntry,
  hasUsdaLink,
  parsePositive,
  UnitInput,
} from "./workbench-editor-core";

type FilterKey = "all" | "no-product" | "partial" | "no-usda";

/** An AI USDA suggestion for one row, kept at the table level for bulk review. */
type Suggestion = {
  food: FoodSummaryWithLinkedProducts;
  confidence: Confidence;
  reasoning: string;
};

/** One editable conversion row in the editor (the user can add several). */
type ConvRow = {
  id: string;
  fromQty: string;
  fromUnit: string;
  toQty: string;
  toUnit: string;
};
let convRowSeq = 0;
const blankConvRow = (fromUnit = ""): ConvRow => ({
  id: `c${convRowSeq++}`,
  fromQty: "1",
  fromUnit,
  toQty: "",
  toUnit: "g",
});

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

  const counts = useMemo(
    () => ({
      all: rows.length,
      "no-product": rows.filter((r) => r.recommendedFix === "no-product")
        .length,
      partial: rows.filter((r) => r.recommendedFix !== "no-product").length,
      "no-usda": rows.filter((r) => !hasUsdaLink(r)).length,
    }),
    [rows],
  );

  const visible = useMemo(
    () =>
      match(filter)
        .with("all", () => rows)
        .with("no-product", () =>
          rows.filter((r) => r.recommendedFix === "no-product"),
        )
        .with("partial", () =>
          rows.filter((r) => r.recommendedFix !== "no-product"),
        )
        .with("no-usda", () => rows.filter((r) => !hasUsdaLink(r)))
        .exhaustive(),
    [rows, filter],
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
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
              "rounded-md px-2.5 py-1 text-sm transition-colors",
              filter === key
                ? "bg-secondary font-medium"
                : "text-muted-foreground hover:bg-accent",
            )}
          >
            {label} {counts[key]}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {(["browse", "review"] as const).map((v) => (
            <Button
              key={v}
              type="button"
              size="sm"
              variant={view === v ? "secondary" : "ghost"}
              className="h-7 px-2.5 text-xs capitalize"
              onClick={() => setView(v)}
            >
              {v}
            </Button>
          ))}
        </div>
      </div>

      {view === "review" && (
        <ReviewQueue rows={visible} onExit={() => setView("browse")} />
      )}

      {view === "browse" && (
        <>
          {suggestionCount > 0 && (
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
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
              </div>
              {createMany.progress && (
                <Progress
                  value={createMany.progress.done}
                  max={createMany.progress.total}
                />
              )}
              <div className="space-y-1.5">
                {Object.entries(suggestions).map(([id, sug]) => {
                  const row = rows.find((r) => r.id === id);
                  if (!row) return null;
                  const p = suggestionPrices[id] ?? {
                    dollars: "",
                    qty: "1",
                    unit: "lb",
                  };
                  return (
                    <div
                      key={id}
                      className="flex flex-wrap items-center gap-2 text-sm"
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
                      <span className="ml-auto flex items-center gap-1 text-xs">
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
                      </span>
                    </div>
                  );
                })}
              </div>
              <p className="text-2xs text-muted-foreground">
                Price optional — leave blank to create the USDA link and price
                later. Foods are usually priced by package (e.g. $5.99 / 2 lb);
                a unit of “each” stores a per-item price.
              </p>
            </div>
          )}

          {error && (
            <div className="text-destructive text-sm">{error.message}</div>
          )}

          {!isLoading && rows.length === 0 && (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground text-sm">
              Every recipe ingredient is fully costable. Nothing to enrich.
            </div>
          )}

          {visible.length > 0 && (
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-2xs text-muted-foreground uppercase tracking-wide">
                    <th className="w-8 px-2 py-2" />
                    <th className="w-8 px-2 py-2" />
                    <th className="px-2 py-2 font-medium">Ingredient</th>
                    <th className="px-2 py-2 font-medium">Coverage</th>
                    <th className="px-2 py-2 font-medium">Next</th>
                  </tr>
                </thead>
                <tbody>
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
                </tbody>
              </table>
            </div>
          )}

          {isLoading && (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          )}

          {selected.size > 0 && (
            <div className="sticky bottom-4 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 px-4 py-2.5 shadow-sm backdrop-blur">
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
            </div>
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
    </div>
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
    <div className="mt-1 flex items-center gap-1.5">
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
    </div>
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
      <tr
        ref={rowRef}
        className={cn(
          "cursor-pointer border-b transition-colors hover:bg-accent/40",
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
        <td className="px-2 py-2.5">
          <Checkbox
            checked={selected}
            onCheckedChange={onToggle}
            aria-label={`Select ${row.name}`}
          />
        </td>
        <td className="px-2 py-2.5 text-muted-foreground">
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </td>
        <td className="px-2 py-2.5">
          <div className="font-medium">{row.name}</div>
          <div className="text-muted-foreground text-xs">
            × {row.recipeCount} recipe{row.recipeCount === 1 ? "" : "s"}
            {suggestion && (
              <span className="ml-1.5 text-info">
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
        </td>
        <td className="px-2 py-2.5">
          <CoverageChips
            covered={row.coverage.covered}
            applicable={row.coverage.applicable}
          />
        </td>
        <td className="px-2 py-2.5">
          <Badge variant="outline" className="font-normal">
            {fixBadgeLabel(row)}
          </Badge>
        </td>
      </tr>
      {open && (
        <tr className="border-b bg-muted/20">
          <td />
          <td />
          <td colSpan={3} className="px-2 py-3 pr-4">
            <WorkbenchEditor
              row={row}
              initialFood={suggestion?.food ?? null}
              onDone={() => setOpen(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * Unified inline editor. For a bare ingredient it creates the first product; for
 * one with a product it updates the first one. Either way: link a USDA food
 * (fills weight/volume/calories), set a price ("<qty> <unit> = $<price>": `each`
 * → the scalar per-each price, a measure like 2 lb → a money unit mapping so
 * weight/volume recipe lines stay costable), and optionally add one conversion.
 * Works off the row's already-loaded products, so updates merge with existing
 * mappings without a refetch.
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
  const usdaLinked = hasUsdaLink(row);

  // Current state shown before the inputs (same as the Problems inline fix):
  // the linked USDA food(s) and the effective core-4 conversions, derived from
  // the row's already-loaded products — no refetch.
  const linkedFoods = row.product
    .map((p) => p.food)
    .filter((f): f is NonNullable<typeof f> => f != null);
  const currentMappings = useMemo<UnitMapping[]>(() => {
    try {
      return getIngredientMappings(row).filter(isDisplayMapping);
    } catch {
      return [];
    }
  }, [row]);

  // Which base kinds are still uncovered, so the steps reflect what each fix
  // actually closes: price closes money; a conversion closes a measure/calorie
  // gap. The conversion is only "optional" once nothing measurable is missing —
  // setting a price won't cover volume, so don't pretend it's optional then.
  const covered = new Set(row.coverage.covered);
  // Kinds the user hasn't marked N/A — a gap only counts against an applicable kind.
  const applicableKinds = new Set(row.coverage.applicable);
  const moneyMissing = applicableKinds.has("money") && !covered.has("money");
  const usdaUnavailable = row.product.some((p) => p.usdaUnavailable);
  const conversionGaps = (["weight", "volume", "calories"] as const).filter(
    (k) => applicableKinds.has(k) && !covered.has(k),
  );
  // A conversion is the path for those gaps only once USDA can't fill them
  // (already linked, or there's no USDA entry). Before that, linking USDA is.
  const conversionNeeded =
    conversionGaps.length > 0 && (usdaLinked || usdaUnavailable);

  // Islanded price: a price exists but money is unreachable from a measure (e.g.
  // a per-each price on a food whose portions only map "large"/"cup" → g, never
  // "each" → g). The fix is to *connect* the existing price, not add a new one —
  // bridge its measure-side unit into the weight graph (`1 each = N g`).
  const priceEdge = currentMappings.find(
    (m) => isMoneyUnit(m.a.unit) || isMoneyUnit(m.b.unit),
  );
  const priceIslanded = moneyMissing && priceEdge != null;
  const islandedUnit = priceEdge
    ? isMoneyUnit(priceEdge.a.unit)
      ? priceEdge.b.unit
      : priceEdge.a.unit
    : null;

  const [food, setFood] = useState<FoodSummaryWithLinkedProducts | null>(
    initialFood,
  );
  const [priceQty, setPriceQty] = useState("1");
  const [priceUnit, setPriceUnit] = useState(defaultPriceUnit(row));
  const [price, setPrice] = useState("");
  // One or more conversion rows; the first is pre-seeded to bridge an islanded
  // price into grams when applicable.
  const [convRows, setConvRows] = useState<ConvRow[]>([
    blankConvRow(islandedUnit ?? ""),
  ]);
  const patchConvRow = (id: string, patch: Partial<ConvRow>) =>
    setConvRows((rows) =>
      rows.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    );
  const addConvRow = () => setConvRows((rows) => [...rows, blankConvRow()]);
  const removeConvRow = (id: string) =>
    setConvRows((rows) => rows.filter((r) => r.id !== id));

  // Live preview of the mapping graph as it would be after this edit (shared with
  // the review card so both light up coverage identically).
  const previewMappings = useMemo<UnitMapping[]>(
    () =>
      buildPreviewMappings(row, {
        food,
        dollars: price,
        qty: priceQty,
        unit: priceUnit,
        convRows,
      }),
    [row, food, price, priceQty, priceUnit, convRows],
  );

  const createProduct = useActionMutation({
    mutationFn: api.product.create.mutationOptions,
    success: `Enriched ${row.name}.`,
    invalidateKeys: [["ingredient"]],
    onSuccess: onDone,
    error: (err) => `Failed to create product: ${getErrorMessage(err)}`,
  });
  const updateProduct = useActionMutation({
    mutationFn: api.product.update.mutationOptions,
    success: `Updated ${row.name}.`,
    invalidateKeys: [["ingredient"], ["product"]],
    onSuccess: onDone,
    error: (err) => `Failed to update: ${getErrorMessage(err)}`,
  });

  // Toggle a base kind's "not applicable" flag on the ingredient. Marking volume
  // N/A on a count-only item (e.g. whole lemons) drops it from the graded
  // universe, so the row reads "complete" instead of nagging for a volume it's
  // never measured by. Invalidates the worklist so coverage recomputes.
  const updateIngredient = useActionMutation({
    mutationFn: api.ingredient.update.mutationOptions,
    success: `Updated ${row.name}.`,
    invalidateKeys: [["ingredient"]],
    error: (err) => `Failed to update: ${getErrorMessage(err)}`,
  });
  const naKinds = row.naKinds ?? [];
  const toggleNaKind = (kind: BaseKind) => {
    const next = new Set(naKinds);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    updateIngredient.mutate({ id: row.id, data: { naKinds: [...next] } });
  };

  const buildPriceAndMappings = () => {
    let eachPrice: number | null = null;
    const newMappings: UnitMappingInput[] = [];

    const built = buildPackagePrice(price, priceQty, priceUnit);
    eachPrice = built.eachPrice;
    if (built.mapping) newMappings.push(built.mapping);

    for (const c of convRows) {
      const fromQty = parsePositive(c.fromQty);
      const toQty = parsePositive(c.toQty);
      const fromUnit = c.fromUnit.trim();
      const toUnit = c.toUnit.trim();
      if (fromQty != null && toQty != null && fromUnit && toUnit) {
        newMappings.push({
          a: { value: fromQty, unit: fromUnit },
          b: { value: toQty, unit: toUnit },
          source: "manual: conversion (workbench)",
        });
      } else if (fromUnit || c.toQty.trim()) {
        // A half-filled row is a mistake, not an empty extra — tell the user.
        return { error: "Fill in both sides of each conversion" as const };
      }
    }

    return { eachPrice, newMappings };
  };

  const save = () => {
    const built = buildPriceAndMappings();
    if ("error" in built) {
      toast.error(built.error);
      return;
    }
    const { eachPrice, newMappings } = built;

    if (food == null && eachPrice == null && newMappings.length === 0) {
      toast.error("Link a USDA food, set a price, or add a conversion first");
      return;
    }

    const write = buildProductWrite(row, { food, eachPrice, newMappings });
    if (write.kind === "create") createProduct.mutate(write.input);
    else updateProduct.mutate({ id: write.id, data: write.data });
  };

  const isPending = createProduct.isPending || updateProduct.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="shrink-0 space-y-3 lg:w-80">
          {product && row.coverage.tier !== "complete" && (
            <p className="text-xs">
              <span className="font-medium text-warning">Still missing:</span>{" "}
              {[
                applicableKinds.has("weight") &&
                  !covered.has("weight") &&
                  "weight",
                applicableKinds.has("volume") &&
                  !covered.has("volume") &&
                  "volume",
                moneyMissing &&
                  (priceIslanded ? "price (not connected)" : "price"),
                applicableKinds.has("calories") &&
                  !covered.has("calories") &&
                  "calories",
              ]
                .filter(Boolean)
                .join(", ")}
            </p>
          )}

          {!usdaLinked && (
            <div className="space-y-1">
              <p className="font-medium text-xs">
                Link a USDA food{" "}
                <span className="font-normal text-muted-foreground">
                  — fills weight, volume &amp; calories
                </span>
              </p>
              <UsdaFoodSearchField
                initialQuery={row.name}
                label=""
                onSelect={setFood}
              />
              {food && (
                <p className="flex items-center gap-1 text-positive text-xs">
                  <Check className="h-3 w-3" />
                  {food.foodInfo.description}
                </p>
              )}
            </div>
          )}

          {priceIslanded && (
            <p className="rounded-md border bg-warning/10 px-2 py-1.5 text-warning text-xs">
              Already priced, but “{islandedUnit}” isn’t linked to a weight — so
              the price can’t be reached from a recipe measure. Connect it below
              (e.g. 1 {islandedUnit} = N&nbsp;g) instead of adding a new price.
            </p>
          )}

          {moneyMissing && !priceIslanded && (
            <div className="space-y-1">
              <p className="font-medium text-xs">Set a price</p>
              <div className="flex items-center gap-1.5 text-sm">
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  value={priceQty}
                  onChange={(e) => setPriceQty(e.target.value)}
                  className="w-12"
                  aria-label="Price quantity"
                />
                <UnitInput
                  value={priceUnit}
                  onChange={setPriceUnit}
                  ariaLabel="Price unit"
                />
                <span>= $</span>
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="w-20"
                />
              </div>
              <p className="text-muted-foreground text-xs">
                For foods, price by the package, e.g. 2&nbsp;lb = $5.99. Use
                “each” for count items.
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <p className="font-medium text-xs">
              {priceIslanded ? "Connect the price" : "Add conversions"}{" "}
              <span className="font-normal text-muted-foreground">
                {priceIslanded
                  ? `— links “${islandedUnit}” to grams so your price is reachable`
                  : conversionNeeded
                    ? `— covers ${conversionGaps.join(", ")} (e.g. 1 cup = 240 g)`
                    : "— optional, e.g. 1 cup = 240 g"}
              </span>
            </p>
            {convRows.map((c) => (
              <div key={c.id} className="flex items-center gap-1.5 text-sm">
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  value={c.fromQty}
                  onChange={(e) =>
                    patchConvRow(c.id, { fromQty: e.target.value })
                  }
                  className="w-12"
                  aria-label="From quantity"
                />
                <UnitInput
                  value={c.fromUnit}
                  onChange={(v) => patchConvRow(c.id, { fromUnit: v })}
                  placeholder="cup"
                  ariaLabel="From unit"
                />
                <span>=</span>
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  value={c.toQty}
                  onChange={(e) =>
                    patchConvRow(c.id, { toQty: e.target.value })
                  }
                  className="w-14"
                  aria-label="To quantity"
                />
                <UnitInput
                  value={c.toUnit}
                  onChange={(v) => patchConvRow(c.id, { toUnit: v })}
                  placeholder="g"
                  ariaLabel="To unit"
                />
                {convRows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeConvRow(c.id)}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label="Remove conversion"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
            <button
              type="button"
              onClick={addConvRow}
              className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
            >
              <Plus className="h-3 w-3" /> Add another
            </button>
          </div>

          <div className="flex items-center gap-2">
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
          </div>
        </div>

        {(linkedFoods.length > 0 || currentMappings.length > 0) && (
          <div className="min-w-0 flex-1 space-y-1 rounded-md border bg-background/60 p-2">
            {linkedFoods.length > 0 && (
              <p className="flex items-center gap-1 text-xs">
                <Check className="h-3 w-3 text-positive" />
                <span className="text-muted-foreground">Linked USDA:</span>{" "}
                {linkedFoods.map((f) => f.foodInfo.description).join(", ")}
              </p>
            )}
            {currentMappings.length > 0 && (
              <div className="space-y-1">
                <p className="font-medium text-xs">Current conversions</p>
                <UnitMappingsTable mappings={currentMappings} />
              </div>
            )}
          </div>
        )}

        <div className="shrink-0 space-y-1 lg:w-72">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Unit graph (live)
          </p>
          <UnitMappingGraph mappings={previewMappings} />
          <p className="text-[10px] text-muted-foreground leading-tight">
            Units as nodes, conversions as edges (dashed = built-in, e.g. g↔lb).
            A disconnected cluster (e.g. an islanded price) floats off on its
            own.
          </p>
        </div>

        <div className="shrink-0 space-y-1 lg:w-56">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Coverage (live)
          </p>
          <div className="rounded-md border bg-background/60 p-2">
            <ConversionCapabilities
              mappings={previewMappings}
              kinds={row.coverage.applicable}
              hideConvertButton
            />
          </div>
          {/* Per-kind "not applicable" opt-out — drops a kind from grading so a
            count-only ingredient (e.g. whole lemons, never measured by volume)
            reads complete instead of being nagged for a gap it can't fill. */}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1">
            <span className="text-[10px] text-muted-foreground uppercase tracking-wide">
              N/A
            </span>
            {BASE_KINDS.map((kind) => {
              const off = naKinds.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  disabled={updateIngredient.isPending}
                  onClick={() => toggleNaKind(kind)}
                  aria-pressed={off}
                  className={cn(
                    "flex items-center gap-1 text-[11px]",
                    off ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Checkbox
                    checked={off}
                    className="pointer-events-none h-3 w-3"
                  />
                  {kind === "money" ? "price" : kind}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {row.recipeUsages.length > 0 && (
        <div className="space-y-1.5">
          <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Appears in {row.recipeCount} recipe
            {row.recipeCount === 1 ? "" : "s"}
          </p>
          <div className="overflow-x-auto rounded-md border bg-background/60 p-2">
            <RecipeUsagesTable
              usages={row.recipeUsages}
              ingredientName={row.name}
              aliases={row.aliases}
            />
          </div>
        </div>
      )}
    </div>
  );
}
