import type { EnrichmentRow } from "@cubby/schemas/ingredient";
import type {
  productCreateManyInput,
  productMarkUsdaUnavailableManyInput,
} from "@cubby/schemas/product";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { match } from "ts-pattern";
import type { z } from "zod";

import { verbDef } from "~/app/_components/actions/action-verbs";
import { confidenceColor } from "~/app/_components/ai/ai-proposal-card";
import type { BulkActionsConfig } from "~/app/_components/data-table/bulk-actions.types";
import { createNameColumn } from "~/app/_components/data-table/columnHelpers";
import { ListWorkbench } from "~/app/_components/data-table/ListWorkbench";
import {
  createCubbyColumnCollection,
  createCubbyColumnHelper,
} from "~/app/_components/data-table/table-features";
import { useActionMutation } from "~/app/_components/hooks/useActionMutation";
import { useBulkActionMutation } from "~/app/_components/hooks/useBulkActionMutation";
import { useClientEntityList } from "~/app/_components/hooks/useClientEntityList";
import {
  type EntityPreviewRendererProps,
  useEntityPreview,
} from "~/app/_components/hooks/useEntityPreview";
import { EntityMergeDialog } from "~/app/_components/merge/entity-merge-dialog";
import { CoverageChips } from "~/app/problems/components/unit-coverage-fix";
import {
  createManyProductsStream,
  markProductsUsdaUnavailableStream,
} from "~/app/products/product.functions";
import { Row, Stack } from "~/components/layout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyTitle } from "~/components/ui/empty";
import { Progress } from "~/components/ui/progress";
import {
  ViewSwitcher,
  type ViewSwitcherOption,
} from "~/components/ui/view-switcher";
import { entityDetailFor } from "~/entities/entity-detail.functions";
import { useHydrated } from "~/hooks/useHydrated";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { ai } from "~/lib/ai.functions";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { cn } from "~/lib/utils";

import {
  type EquivalenceDraft,
  enrichmentWorkbenchQueryInput,
} from "./equivalence-workbench-link";
import { ingredient } from "./ingredient.functions";
import { ReviewQueue } from "./review-queue";
import { SuggestionReviewTray } from "./suggestion-review-tray";
import {
  buildPackagePrice,
  hasUsdaLink,
  isCookbookOnly,
} from "./workbench-editor-core";
import { fixBadgeLabel } from "./workbench-fix-label";
import { EnrichmentWorkbenchInspector, type Suggestion } from "./workbench-row";

type FilterKey = "all" | "no-product" | "partial" | "no-usda";
type WorkbenchView = "browse" | "review";

const WORKBENCH_VIEW_OPTIONS: ViewSwitcherOption<WorkbenchView>[] = [
  { value: "browse", label: "Browse" },
  { value: "review", label: "Review" },
];
const WORKBENCH_FILTER_OPTIONS = [
  ["all", "All"],
  ["no-product", "No product"],
  ["partial", "Partial"],
  ["no-usda", "No USDA"],
] as const;

type MergeSuggestion = { targetId: string; targetName: string };

type EnrichmentTableRow = EnrichmentRow & {
  focusRank: number;
  suggestion: Suggestion | null;
  mergeSuggestion: MergeSuggestion | null;
};

const ENRICHMENT_TABLE_STATE = {
  initialSort: "focusRank",
  initialSortDesc: false,
  initialPagination: { pageIndex: 0, pageSize: 50 },
  urlSync: false,
  readUrlState: false,
  syncPaginationToUrl: false,
} as const;

// Single-sourced from the action-verb registry so the workbench can't drift
// from the ingredient list's own Merge — it had been rendering `GitMerge`
// where every other merge affordance uses `Merge`.
const { icon: MergeIcon, label: mergeLabel } = verbDef("merge");

export function canMarkAllSelectedNoUsda(
  rows: readonly { hasProduct: boolean; hasUsdaLink: boolean }[],
): boolean {
  return (
    rows.length > 0 && rows.every((row) => row.hasProduct && !row.hasUsdaLink)
  );
}

function WorkbenchScopeBanner({
  recipeId,
  recipeName,
}: {
  recipeId: string | undefined;
  recipeName: string | undefined;
}) {
  if (!recipeId) return null;
  return (
    <Row
      align="center"
      wrap
      gap="sm"
      className="border border-[var(--border)] bg-muted/40 px-4 py-2 text-sm"
    >
      <Badge variant="secondary">Scoped</Badge>
      <span className="text-muted-foreground">
        {recipeName ?? "this recipe"} + sub-recipes
      </span>
      <Link
        to="/ingredients/workbench"
        className="ml-auto text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Clear
      </Link>
    </Row>
  );
}

function WorkbenchFilterToolbar({
  filter,
  counts,
  cookbookOnlyCount,
  hideCookbookOnly,
  view,
  onFilterChange,
  onToggleCookbookOnly,
  onViewChange,
}: {
  filter: FilterKey;
  counts: Record<FilterKey, number>;
  cookbookOnlyCount: number;
  hideCookbookOnly: boolean;
  view: WorkbenchView;
  onFilterChange: (filter: FilterKey) => void;
  onToggleCookbookOnly: () => void;
  onViewChange: (view: WorkbenchView) => void;
}) {
  return (
    <Row align="center" wrap gap="sm">
      {WORKBENCH_FILTER_OPTIONS.map(([key, label]) => (
        <Button
          type="button"
          key={key}
          onClick={() => onFilterChange(key)}
          variant={filter === key ? "secondary" : "outline"}
          size="sm"
          aria-pressed={filter === key}
        >
          {label} {counts[key]}
        </Button>
      ))}
      {cookbookOnlyCount > 0 && (
        <Button
          type="button"
          onClick={onToggleCookbookOnly}
          aria-pressed={hideCookbookOnly}
          variant={hideCookbookOnly ? "secondary" : "outline"}
          size="sm"
        >
          Hide cookbook-only ({cookbookOnlyCount})
        </Button>
      )}
      <ViewSwitcher
        className="ml-auto"
        ariaLabel="Workbench view"
        options={WORKBENCH_VIEW_OPTIONS}
        value={view}
        onValueChange={onViewChange}
      />
    </Row>
  );
}

/** Keep query recovery and the successful empty state mutually exclusive. */
export function shouldShowEnrichmentEmptyState({
  isLoading,
  hasError,
  rowCount,
}: {
  isLoading: boolean;
  hasError: boolean;
  rowCount: number;
}): boolean {
  return !isLoading && !hasError && rowCount === 0;
}

/**
 * Dense bulk-enrichment table for ingredients with incomplete totals data —
 * the bare ones EPUB imports leave behind (no product) plus those with a product
 * whose conversion graph is still incomplete. Each row shows its coverage and the
 * single recommended fix. The current row opens in a responsive inspector for
 * focused editing, while selection independently drives AI and bulk operations.
 */
export function EnrichmentWorkbench({
  focus,
  recipeId,
  initialConversion,
}: {
  focus?: string;
  recipeId?: string;
  initialConversion?: EquivalenceDraft;
}) {
  const [filter, setFilter] = useState<FilterKey>("all");
  const [view, setView] = useState<WorkbenchView>("browse");
  // Layered on top of the chips: drop ingredients used only in imported cookbook
  // recipes (the long noise tail) from counts + the visible/review set.
  const [hideCookbookOnly, setHideCookbookOnly] = useState(false);
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
    Record<string, MergeSuggestion>
  >({});
  // The ingredient pair awaiting a merge — fed to the shared MergeConfirmation,
  // which lets the user pick the keeper (the candidate is listed first, so it's
  // the default target). `mergeTargetRef` mirrors that choice for onExecute.
  const [mergeConfirm, setMergeConfirm] = useState<
    { id: string; name: string }[] | null
  >(null);
  const setSelectionRef = useRef<(ids: readonly string[]) => void>(
    () => undefined,
  );

  const {
    data: worklist,
    isLoading: worklistLoading,
    error,
    refetch,
  } = useQuery(
    // Pass no input when unscoped so the query key matches the plain worklist.
    ingredient.enrichmentWorkbench.queryOptions(
      enrichmentWorkbenchQueryInput({ focus, recipeId, initialConversion }),
    ),
  );
  // Hydration-stable: the server renders this with no worklist, while the
  // client's first render already has the streamed one — so both the spinner
  // and the derived `rows`/`visible` have to ignore the data until hydration
  // finishes, or React discards the tree. See useHydratedLoading.
  const hydrated = useHydrated();
  const data = hydrated ? worklist : undefined;
  const isLoading = !hydrated || worklistLoading;

  // Recipe-scoped worklist: fetch the recipe name for the scope banner.
  const { data: scopeRecipe } = useQuery({
    ...entityDetailFor("recipe").queryOptions(recipeId ?? ""),
    enabled: !!recipeId,
  });

  const rows = useMemo(() => data ?? [], [data]);

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

  const suggestUsda = useMutation(ai.suggestUsdaFoodBatch.mutationOptions());
  const createMany = useBulkActionMutation({
    run: (vars: z.input<typeof productCreateManyInput>) =>
      createManyProductsStream(vars),
    success: (data) =>
      data.failed.length === 0
        ? `Created ${data.created} product${data.created === 1 ? "" : "s"}.`
        : `Created ${data.created}, ${data.failed.length} failed.`,
    invalidateTags: ripple.ingredientProduct,
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
      setSelectionRef.current([...failed]);
      for (const f of data.failed) {
        toast.error(`${f.name}: ${f.error}`);
      }
    },
    error: (err) => `Create failed: ${getErrorMessage(err)}`,
  });
  const markNoUsda = useBulkActionMutation({
    run: (vars: z.input<typeof productMarkUsdaUnavailableManyInput>) =>
      markProductsUsdaUnavailableStream(vars),
    success: "Marked: no USDA entry.",
    invalidateTags: ripple.ingredientProduct,
    onSuccess: () => setSelectionRef.current([]),
    error: (err) => `Failed: ${getErrorMessage(err)}`,
  });
  const markNoUsdaMutateAsync = markNoUsda.mutateAsync;
  const suggestMerges = useMutation(
    ai.suggestIngredientMergeBatch.mutationOptions(),
  );
  const suggestUsdaAsync = suggestUsda.mutateAsync;
  const suggestMergesAsync = suggestMerges.mutateAsync;
  const mergeMutation = useActionMutation({
    mutationFn: ingredient.merge.mutationOptions,
    success: (data) => savedWithBackgroundWork(data.sideEffects, "Merged"),
    error: (err) => `Merge failed: ${getErrorMessage(err)}`,
  });

  const handleSuggestMerges = useCallback(
    async (selectedRows: readonly EnrichmentTableRow[]) => {
      const ingredients = selectedRows.map((row) => ({
        id: row.id,
        name: row.name,
      }));
      if (ingredients.length === 0) return false;
      try {
        const results = await suggestMergesAsync({ ingredients });
        const next: Record<string, MergeSuggestion> = {};
        let matched = 0;
        for (const result of results) {
          if (result.target) {
            next[result.source.id] = {
              targetId: result.target.id,
              targetName: result.target.name,
            };
            matched++;
          }
        }
        setMergeSuggestions((previous) => ({ ...previous, ...next }));
        toast.success(`AI found ${matched} merge${matched === 1 ? "" : "s"}.`);
        return true;
      } catch (caught) {
        toast.error(`Merge suggestion failed: ${getErrorMessage(caught)}`);
        return false;
      }
    },
    [suggestMergesAsync],
  );

  // Open the shared merge confirmation for a pair. Merge candidates are
  // suggestions — the AI ones and especially the trigram ones have false
  // positives (e.g. "red wine vinegar" ~ "white wine vinegar") — so the user
  // confirms and picks the keeper. The candidate goes first so it's the default
  // target (it's the one likelier to already have a product/enrichment).
  const requestMerge = useCallback(
    (pair: {
      source: { id: string; name: string };
      target: { id: string; name: string };
    }) => setMergeConfirm([pair.target, pair.source]),
    [],
  );

  // Execute the merge the user confirmed: keeper = the chosen target, the other
  // becomes an alias (deleted, its recipe lines + products repoint to the keeper).
  const confirmMerge = (keepId: string, aliasIds: string[]) => {
    mergeMutation.mutate({ keepId, mergeIds: aliasIds });
    setMergeSuggestions((prev) => {
      const next = { ...prev };
      for (const aliasId of aliasIds) delete next[aliasId];
      return next;
    });
    setMergeConfirm(null);
  };

  const handleSuggest = useCallback(
    async (selectedRows: readonly EnrichmentTableRow[]) => {
      const ingredients = selectedRows.map((row) => ({
        id: row.id,
        name: row.name,
      }));
      if (ingredients.length === 0) return false;
      const byName = new Map(
        selectedRows.map((row) => [row.name.toLowerCase(), row.id]),
      );
      try {
        const results = await suggestUsdaAsync({ ingredients });
        const next: Record<string, Suggestion> = {};
        let matched = 0;
        for (const result of results) {
          const id = byName.get(result.name.toLowerCase());
          if (id && result.food) {
            next[id] = {
              food: result.food,
              confidence: result.confidence,
              reasoning: result.reasoning,
            };
            matched++;
          }
        }
        setSuggestions((previous) => ({ ...previous, ...next }));
        toast.success(`AI matched ${matched}/${ingredients.length}.`);
        return true;
      } catch (caught) {
        toast.error(`Suggestion failed: ${getErrorMessage(caught)}`);
        return false;
      }
    },
    [suggestUsdaAsync],
  );

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

  const tableRows = useMemo<EnrichmentTableRow[]>(
    () =>
      visible.map((row) => ({
        ...row,
        focusRank: row.id === focus ? 0 : 1,
        suggestion: suggestions[row.id] ?? null,
        mergeSuggestion: mergeSuggestions[row.id] ?? null,
      })),
    [focus, mergeSuggestions, suggestions, visible],
  );

  const renderInspector = useCallback(
    ({ preview, onClose }: EntityPreviewRendererProps) => {
      const row = tableRows.find((candidate) => candidate.id === preview.id);
      if (!row) return null;
      return (
        <EnrichmentWorkbenchInspector
          key={row.id}
          row={row}
          initialFood={row.suggestion?.food ?? null}
          initialConversion={row.id === focus ? initialConversion : undefined}
          onDone={onClose}
        />
      );
    },
    [focus, initialConversion, tableRows],
  );
  const {
    onRowClick,
    inspectRow,
    onRowHover,
    onRowHoverEnd,
    PreviewSheet,
    preview,
    dockedInspector,
    inspectorToggle,
  } = useEntityPreview("ingredient", {
    responsiveInspector: true,
    mobileBehavior: "sheet",
    renderInspector,
  });

  const handledFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focus || isLoading || handledFocusRef.current === focus) return;
    handledFocusRef.current = focus;
    const row = tableRows.find((candidate) => candidate.id === focus);
    if (!row) {
      toast.info("That ingredient isn't in the workbench worklist.");
      return;
    }
    onRowClick({ id: row.id, original: row });
  }, [focus, isLoading, onRowClick, tableRows]);

  const columnHelper = useMemo(
    () => createCubbyColumnHelper<EnrichmentTableRow>(),
    [],
  );
  const columns = useMemo(
    () =>
      createCubbyColumnCollection<EnrichmentTableRow>((add) => {
        add(
          columnHelper.accessor("focusRank", {
            header: "Focus",
            enableSorting: true,
            meta: { mobile: { slot: "hidden" } },
          }),
        );
        add(
          createNameColumn(columnHelper, "ingredient", "name", {
            header: "Ingredient",
            className: "w-72",
            nameSuffix: (row) =>
              row.suggestion ? (
                <Badge
                  variant="secondary"
                  className={cn(
                    "max-w-32 truncate font-normal",
                    confidenceColor[row.suggestion.confidence],
                  )}
                  title={`AI: ${row.suggestion.food.foodInfo.description}`}
                >
                  AI {row.suggestion.confidence}
                </Badge>
              ) : null,
          }),
        );
        add(
          columnHelper.accessor((row) => row.coverage.tier, {
            id: "coverage",
            header: "Coverage",
            enableSorting: false,
            meta: {
              className: "w-48",
              mobile: { slot: "subtitle", priority: 10, label: "Coverage" },
            },
            cell: (info) => (
              <CoverageChips
                covered={info.row.original.coverage.covered}
                applicable={info.row.original.coverage.applicable}
              />
            ),
          }),
        );
        add(
          columnHelper.accessor("recommendedFix", {
            id: "recommendedFix",
            header: "Next",
            enableSorting: false,
            meta: {
              className: "w-64",
              mobile: {
                slot: "meta",
                priority: 20,
                label: "Next",
                interactive: true,
              },
            },
            cell: (info) => {
              const row = info.row.original;
              const candidate =
                row.mergeSuggestion ?? row.mergeCandidates[0] ?? null;
              const mergeTarget = candidate
                ? "targetId" in candidate
                  ? {
                      id: candidate.targetId,
                      name: candidate.targetName,
                    }
                  : { id: candidate.id, name: candidate.name }
                : null;
              return (
                <Row align="center" gap="xs" className="min-w-0">
                  <Badge variant="outline" className="shrink-0 font-normal">
                    {fixBadgeLabel(row)}
                  </Badge>
                  {mergeTarget ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 min-w-0 px-2"
                      title={`Merge with ${mergeTarget.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        requestMerge({
                          source: { id: row.id, name: row.name },
                          target: mergeTarget,
                        });
                      }}
                    >
                      <MergeIcon className="size-3" />
                      <span className="truncate">{mergeLabel}</span>
                    </Button>
                  ) : null}
                </Row>
              );
            },
          }),
        );
      }),
    [columnHelper, requestMerge],
  );

  const bulkActions = useMemo<BulkActionsConfig<EnrichmentTableRow>>(
    () => ({
      clearSelectionOnComplete: false,
      actions: [
        {
          id: "suggest-usda",
          label: "Suggest USDA",
          icon: <Sparkles className="size-3.5" />,
          preserveSelection: true,
          onExecute: async (selectedRows) => ({
            success: await handleSuggest(
              selectedRows.map((row) => row.original),
            ),
          }),
        },
        {
          id: "suggest-merges",
          label: "Suggest merges",
          icon: <Sparkles className="size-3.5" />,
          preserveSelection: true,
          onExecute: async (selectedRows) => ({
            success: await handleSuggestMerges(
              selectedRows.map((row) => row.original),
            ),
          }),
        },
        {
          id: "mark-no-usda",
          label: "Mark no-USDA",
          availability: (selectedRows) =>
            canMarkAllSelectedNoUsda(
              selectedRows.map((row) => ({
                hasProduct: row.original.product.length > 0,
                hasUsdaLink: hasUsdaLink(row.original),
              })),
            )
              ? { status: "available" }
              : {
                  status: "disabled",
                  reason:
                    "Every selected ingredient must have a product without a USDA link.",
                },
          onExecute: async (selectedRows) => {
            await markNoUsdaMutateAsync({
              ids: selectedRows.flatMap((row) =>
                row.original.product[0] ? [row.original.product[0].id] : [],
              ),
            });
            return { success: true };
          },
        },
      ],
    }),
    [handleSuggest, handleSuggestMerges, markNoUsdaMutateAsync],
  );

  const { workbench } = useClientEntityList<EnrichmentTableRow>({
    entity: "ingredient",
    data: tableRows,
    isLoading,
    error,
    columns,
    bulkActions,
    onInspectRow: inspectRow,
    includeCatalogActions: false,
    tableStateOptions: ENRICHMENT_TABLE_STATE,
    initialColumnVisibility: {
      focusRank: false,
      createdAt: false,
      updatedAt: false,
    },
  });

  useEffect(() => {
    setSelectionRef.current = (ids) =>
      workbench.table.setRowSelection(
        Object.fromEntries(ids.map((id) => [id, true])),
      );
  }, [workbench.table]);

  const selectedRows = workbench.table
    .getFilteredSelectedRowModel()
    .rows.map((row) => row.original);
  const creatable = selectedRows.filter(
    (row) => row.product.length === 0 && suggestions[row.id],
  );
  const handleCreate = () => {
    if (creatable.length === 0) {
      toast.error("No selected rows have an AI suggestion yet. Suggest first.");
      return;
    }
    createOrderRef.current = creatable.map((row) => row.id);
    createMany.mutate(
      creatable.map((row) => {
        const packagePrice = suggestionPrices[row.id];
        const { eachPrice, mapping } = packagePrice
          ? buildPackagePrice(
              packagePrice.dollars,
              packagePrice.qty,
              packagePrice.unit,
            )
          : { eachPrice: null, mapping: null };
        return {
          name: row.name,
          manufacturer: UNSPECIFIED_MANUFACTURER,
          upc: null,
          expectedQuantity: null,
          ingredientId: row.id,
          fdc_id: suggestions[row.id]!.food.fdc_id,
          price: eachPrice,
          unitMappings: mapping ? [mapping] : [],
        };
      }),
    );
  };

  const tableEmptyState = (
    <Empty variant="minimal" className="py-6">
      <EmptyTitle>
        {rows.length === 0 ? "Nothing to enrich" : "No matching ingredients"}
      </EmptyTitle>
      <EmptyDescription>
        {rows.length === 0
          ? "Every recipe ingredient is fully costable."
          : "Choose another workbench filter."}
      </EmptyDescription>
    </Empty>
  );

  const contextualStatus = error ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void refetch()}
    >
      Try again
    </Button>
  ) : markNoUsda.progress ? (
    <Row align="center" gap="sm" className="min-w-48">
      <span className="text-xs text-muted-foreground">
        Marking {markNoUsda.progress.done}/{markNoUsda.progress.total}
      </span>
      <Progress
        className="w-24"
        value={markNoUsda.progress.done}
        max={markNoUsda.progress.total}
      />
    </Row>
  ) : null;

  return (
    <Stack>
      <WorkbenchScopeBanner
        recipeId={recipeId}
        recipeName={scopeRecipe?.name}
      />
      <WorkbenchFilterToolbar
        filter={filter}
        counts={counts}
        cookbookOnlyCount={cookbookOnlyCount}
        hideCookbookOnly={hideCookbookOnly}
        view={view}
        onFilterChange={setFilter}
        onToggleCookbookOnly={() => setHideCookbookOnly((value) => !value)}
        onViewChange={setView}
      />

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

          <div
            className={cn(
              "min-w-0",
              dockedInspector && "xl:grid xl:grid-cols-[minmax(0,1fr)_25rem]",
            )}
          >
            <ListWorkbench
              model={workbench}
              mode="embedded"
              ariaLabel="Ingredient enrichment workbench"
              contextualStatus={contextualStatus}
              emptyState={tableEmptyState}
              showColumnMenu
              onRowClick={onRowClick}
              onRowHover={onRowHover}
              onRowHoverEnd={onRowHoverEnd}
              currentRowId={preview?.rowKey}
              inspectorToggle={inspectorToggle}
              disableMobileDetailsHref
            />
            {dockedInspector ? (
              <aside className="hidden max-h-[60vh] overflow-y-auto border border-l-0 border-[var(--border)] bg-card xl:block">
                {dockedInspector}
              </aside>
            ) : null}
          </div>
          <PreviewSheet />

          <EntityMergeDialog
            entity="ingredient"
            rows={mergeConfirm ?? []}
            open={mergeConfirm != null}
            onOpenChange={(o) => {
              if (!o) setMergeConfirm(null);
            }}
            onConfirm={confirmMerge}
            isPending={mergeMutation.isPending}
          />
        </>
      )}
    </Stack>
  );
}
