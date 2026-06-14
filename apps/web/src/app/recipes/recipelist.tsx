import type { CookbookId } from "@cubby/schemas/identifiers";
import type { RecipeOut } from "@cubby/schemas/recipe";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { createColumnHelper } from "@tanstack/react-table";
import { BookOpen, ExternalLink, Scale } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { Skeleton } from "~/components/ui/skeleton";
import { formatCurrencyRange, formatNumberRange } from "~/lib/format-range";
import { queryKeys } from "~/lib/query-keys";
import { useTRPC } from "~/trpc/react";
import RTable from "../_components/data-table/Table";
import { useDeletableConfig } from "../_components/hooks/useDeletableConfig";
import { useEntityList } from "../_components/hooks/useEntityList";
import { useEntityPreview } from "../_components/hooks/useEntityPreview";
import { NoneState } from "../_components/NoneState";
import { RecipeTag } from "../_components/recipe/recipe-tag";
import {
  formatYield,
  getServingBasis,
} from "../_components/recipe/recipe-utils";
import { TruncatedList } from "../_components/TruncatedList";

/**
 * A computed list-cell value (cost, calories) whose confidence depends on how
 * many of the recipe's ingredients had the underlying data. When coverage is
 * complete the value stands on its own — no fraction. When partial, the value is
 * preliminary, so it's greyed and annotated with the (covered/total) fraction.
 */
const CoverageValue: React.FC<{
  covered: number;
  total: number;
  children: ReactNode;
}> = ({ covered, total, children }) => {
  const complete = covered >= total;
  return (
    <span
      className={complete ? undefined : "opacity-60"}
      title={`${covered}/${total} ingredients`}
    >
      {children}
      {!complete && (
        <span className="ml-1 hidden text-2xs text-muted-foreground sm:inline">
          ({covered}/{total})
        </span>
      )}
    </span>
  );
};

/**
 * Presence-driven drain for stale recipe totals. While the recipes page is open,
 * recompute the persisted cost/calorie rollups in batches until none remain
 * (recipes start stale, and product/recipe edits mark them stale again), then
 * idle. Costs nothing on days the app isn't opened — there's no cron. Each batch
 * that does work invalidates the list so fresh totals appear.
 */
function useRecipeTotalsDrain() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const drain = useMutation(api.recipe.recomputeStale.mutationOptions());
  // Stable handle so the effect can run once (mutateAsync identity isn't guaranteed).
  const drainRef = useRef(drain.mutateAsync);
  drainRef.current = drain.mutateAsync;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stopped) return;
      try {
        const { processed, remaining } = await drainRef.current({ limit: 25 });
        if (processed > 0 && !stopped) {
          await queryClient.invalidateQueries({
            queryKey: [...queryKeys.recipe.list],
          });
        }
        // Drain quickly while work remains; otherwise re-check occasionally for
        // rows newly invalidated by edits made while the page stays open.
        if (!stopped) timer = setTimeout(tick, remaining > 0 ? 600 : 60_000);
      } catch {
        if (!stopped) timer = setTimeout(tick, 60_000);
      }
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [queryClient]);
}

interface RecipeListProps {
  /** Actions to display in the table toolbar (e.g., "Create New" button) */
  actions?: ReactNode;
  /**
   * Scope the list to a single cookbook by FK id. Set on the cookbook detail
   * page; the table then shows only that cookbook's recipes. Undefined on the
   * main recipes page (shows everything).
   */
  cookbookIdFilter?: CookbookId;
}

export function RecipeList({ actions, cookbookIdFilter }: RecipeListProps) {
  const api = useTRPC();
  const navigate = useNavigate();
  const columnHelper = createColumnHelper<RecipeOut>();
  const { onRowClick, PreviewSheet } = useEntityPreview("recipe");

  // Keep persisted cost/calorie totals fresh while this page is open.
  useRecipeTotalsDrain();

  const columns = useMemo(
    () => [
      // Tags column
      columnHelper.accessor("tags", {
        header: "Tags",
        enableSorting: false,
        meta: {
          className: "w-48",
          mobile: { slot: "subtitle", priority: 10 },
        },
        cell: (info) => {
          const tags = info.getValue();
          if (!tags?.length) return <NoneState />;
          return (
            <TruncatedList
              items={tags}
              maxItems={2}
              renderItem={(tag) => <RecipeTag key={tag} tag={tag} size="sm" />}
            />
          );
        },
      }),
      // Yield column. Accessor (not display) so it sorts server-side; the
      // accessorFn exposes `servings` (recipeList orders "yield" by it), while
      // the cell still shows yield-or-servings.
      columnHelper.accessor((row) => row.servings ?? undefined, {
        id: "yield",
        header: "Yield",
        meta: {
          className: "w-24",
          // Mobile: yield/servings is the most useful at-a-glance datum, and
          // recipe rows have no image — surface it as the row subtitle.
          mobile: { slot: "subtitle", priority: 5 },
        },
        cell: (info) => {
          const recipe = info.row.original;
          if (recipe.yield) return formatYield(recipe.yield);
          if (recipe.servings) return `${recipe.servings} servings`;
          return <NoneState />;
        },
      }),
      // Total cost — read from the server-persisted rollup (recipe.totals).
      // Accessor (not display) so the column sorts server-side by costTotal;
      // null totals = not yet computed (the drain will fill it) → skeleton.
      columnHelper.accessor((row) => row.totals?.costTotal ?? undefined, {
        id: "costTotal",
        header: "Cost",
        meta: {
          className: "w-24",
          mobile: { slot: "trailing", priority: 5 },
        },
        sortUndefined: "last",
        cell: (info) => {
          const recipe = info.row.original;
          const totals = recipe.totals;
          if (!totals) return <Skeleton className="h-4 w-12" />;
          if (!totals.costTotal) return <NoneState />;
          const perItem = getServingBasis(recipe);
          return (
            <div className="space-y-0.5">
              <CoverageValue
                covered={totals.costCovered}
                total={totals.ingredientCount}
              >
                {formatCurrencyRange(totals.costTotal, totals.costTotalUpper)}
              </CoverageValue>
              {perItem && (
                <div className="text-2xs text-muted-foreground">
                  {formatCurrencyRange(
                    totals.costTotal / perItem.divisor,
                    totals.costTotalUpper != null
                      ? totals.costTotalUpper / perItem.divisor
                      : undefined,
                  )}{" "}
                  {perItem.noun === "each" ? "ea" : `/ ${perItem.noun}`}
                </div>
              )}
            </div>
          );
        },
      }),
      // Total calories — server-persisted rollup.
      columnHelper.accessor((row) => row.totals?.caloriesTotal ?? undefined, {
        id: "caloriesTotal",
        header: "Calories",
        meta: {
          className: "w-28",
          mobile: { slot: "trailing", priority: 10 },
        },
        sortUndefined: "last",
        cell: (info) => {
          const recipe = info.row.original;
          const totals = recipe.totals;
          if (!totals) return <Skeleton className="h-4 w-12" />;
          if (!totals.caloriesTotal) return <NoneState />;
          const perItem = getServingBasis(recipe);
          return (
            <div className="space-y-0.5">
              <CoverageValue
                covered={totals.caloriesCovered}
                total={totals.ingredientCount}
              >
                {formatNumberRange(
                  totals.caloriesTotal,
                  totals.caloriesTotalUpper,
                  (n) => `${Math.round(n)}`,
                )}{" "}
                kcal
              </CoverageValue>
              {perItem && (
                <div className="text-2xs text-muted-foreground">
                  {formatNumberRange(
                    totals.caloriesTotal / perItem.divisor,
                    totals.caloriesTotalUpper != null
                      ? totals.caloriesTotalUpper / perItem.divisor
                      : undefined,
                    (n) => `${Math.round(n)}`,
                  )}{" "}
                  kcal {perItem.noun === "each" ? "ea" : `/ ${perItem.noun}`}
                </div>
              )}
            </div>
          );
        },
      }),
      // Source column: cookbook link for book recipes, external URL for web
      // recipes, nothing otherwise.
      columnHelper.accessor("source", {
        header: "Source",
        meta: {
          className: "w-44",
          mobile: { slot: "meta", priority: 30 },
        },
        cell: (info) => {
          const source = info.getValue();
          if (source?.type === "book") {
            const label = (
              <>
                <BookOpen size={14} />
                <span className="max-w-[200px] truncate">{source.book}</span>
              </>
            );
            // Link to the cookbook by id when known; older book rows without a
            // cookbook FK just show the name.
            return source.cookbookId ? (
              <Link
                to="/cookbooks/$cookbookId"
                params={{ cookbookId: source.cookbookId }}
                className="flex items-center gap-1.5 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {label}
              </Link>
            ) : (
              <span className="flex items-center gap-1.5">{label}</span>
            );
          }
          if (source?.type === "website") {
            return (
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink size={14} />
                <span className="max-w-[200px] truncate">{source.url}</span>
              </a>
            );
          }
          return <NoneState />;
        },
      }),
    ],
    [columnHelper],
  );

  const deletableConfig = useDeletableConfig({
    mutationFn: api.recipe.delete.mutationOptions,
    entityLabel: "Recipe",
    invalidateKeys: [[queryKeys.recipe.list]],
  });

  const {
    table,
    isLoading,
    error,
    timing,
    bulkActionBar,
    deleteDialog,
    infiniteScroll,
    refreshControls,
  } = useEntityList({
    entity: "recipe",
    queryOptions: api.recipe.list.queryOptions,
    buildFilters: (ts) => ({
      nameFilter: ts.getColumnFilter("name"),
      // Constant scope when rendered on a cookbook page; merged with the
      // table's own name filter so search-within-a-book still works.
      ...(cookbookIdFilter ? { cookbookId: cookbookIdFilter } : {}),
    }),
    columns,
    nameClassName: "w-64",
    filters: [
      { id: "name", placeholder: "Filter by recipe name..." },
      { id: "source", placeholder: "Filter by source..." },
    ],
    bulkActions: {
      actions: [
        {
          id: "compare",
          label: "Compare",
          icon: <Scale className="h-4 w-4" />,
          minSelection: 2,
          onExecute: (rows) => {
            const ids = rows.map((r) => r.original.id).join(",");
            navigate({ to: "/recipes/compare", search: { ids } });
            return Promise.resolve({ success: true });
          },
        },
      ],
      clearSelectionOnComplete: false, // Don't clear selection after navigating
    },
    deletable: deletableConfig,
    infinite: true,
  });

  return (
    <div>
      <RTable
        table={table}
        isLoading={isLoading}
        error={error}
        ariaLabel="Recipes Table"
        timing={timing}
        entity="recipe"
        onRowClick={onRowClick}
        actions={actions}
        bulkActionBar={bulkActionBar}
        infiniteScroll={infiniteScroll}
        refreshControls={refreshControls}
      />
      <PreviewSheet />
      {deleteDialog}
    </div>
  );
}
