import type { CostType, ExpenseFilters, Trade } from "@cubby/schemas/project";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Grid, Section, Stack } from "~/components/layout";
import { Skeleton } from "~/components/ui/skeleton";
import { getEntityFilters } from "~/entities/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
  soleValue,
} from "~/entities/filters";
import { formatCurrency } from "~/lib/utils";
import { CostTypeDonut } from "./charts/cost-type-donut";
import { CumulativeSpend } from "./charts/cumulative-spend";
import { MonthlySpend } from "./charts/monthly-spend";
import { ProjectBreakdown } from "./charts/project-breakdown";
import type { AggregateMatrixCell } from "./charts/trade-cost-aggregate";
import {
  TradeBarsAggregate,
  TradeCostMatrixAggregate,
} from "./charts/trade-cost-aggregate";
import { VendorBreakdown } from "./charts/vendor-breakdown";
import { expenseAnalyticsQueryOptions } from "./expense.functions";
import {
  type ExpenseAnalyzeConfig,
  expenseAnalyzeConfigFromSearch,
  expenseAnalyzeSearchPatch,
  normalizeExpenseAnalyzeConfig,
} from "./expense-analyze-config";
import { ExpenseSummaryStrip } from "./expense-summary-strip";

const route = getRouteApi("/_authenticated/expenses/");

// The analytics route itself is lazy from the Ledger route, and Analyze is a
// second, table-heavy chunk inside it. That keeps the default charts useful
// while avoiding an eager RTable/layout payload for people who only inspect
// the chart summary.
const ExpenseAggregateExplorer = lazy(() =>
  import("./expense-aggregate-explorer").then((module) => ({
    default: module.ExpenseAggregateExplorer,
  })),
);

/**
 * `view=analytics` — chart-first read over `expense.analytics`'s
 * server-side aggregates (see packages/schemas/src/project.ts's
 * `expenseAnalyticsOut`), replacing the old always-mounted
 * `ExpenseChartStrip` (which fetched every matching row via
 * `expense.chartData` and grouped client-side).
 *
 * Filters are read straight off the route's URL search params through the
 * expense filter manifest — the SAME specs `expenselist.tsx`'s ledger table
 * syncs its column filters through — so this view's totals always agree with
 * the Ledger view's, and a Trade × Cost Type matrix click here writes back to
 * those same params (switching to Ledger afterwards shows the matching rows).
 */
export function ExpenseAnalyticsView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [selectedCostType, setSelectedCostType] = useState<string | null>(null);

  // The SAME manifest the ledger table's filters go through, decoded from the
  // same URL params — so `expense.analytics` is always called with the exact
  // filter set the Ledger view shows (the invariant the two share an input
  // schema for).
  const filters = useMemo(() => {
    const specs = getEntityFilters("expense");
    return buildFiltersFromManifest(
      specs,
      filterGetterFromSearch(specs, search),
    ) as ExpenseFilters;
  }, [search]);

  const { data, isLoading } = useQuery({
    ...expenseAnalyticsQueryOptions(filters),
    staleTime: 60 * 1000,
  });
  const analyzeConfig = useMemo(
    () => expenseAnalyzeConfigFromSearch(search, filters),
    [filters, search],
  );
  const handleAnalyzeConfigChange = useCallback(
    (next: ExpenseAnalyzeConfig) => {
      const normalized = normalizeExpenseAnalyzeConfig(next, filters);
      void navigate({
        search: (prev) => ({
          ...prev,
          ...expenseAnalyzeSearchPatch(normalized),
        }),
      });
    },
    [filters, navigate],
  );

  // A matrix cell is one (trade, costType) pair, so it can only mirror a
  // single-valued filter. With several trades selected nothing is highlighted
  // — deliberately, rather than arbitrarily lighting up the first one.
  const soleTrade = soleValue(filters.trade);
  const activeCell: AggregateMatrixCell | null = soleTrade
    ? { trade: soleTrade, costType: soleValue(filters.costType) ?? null }
    : null;

  const handleCellClick = useCallback(
    (trade: Trade, costType: CostType | null) => {
      const clear =
        activeCell?.trade === trade && activeCell.costType === costType;
      void navigate({
        search: (prev) => ({
          ...prev,
          trade: clear ? undefined : trade,
          costType: clear || costType === null ? undefined : costType,
        }),
        replace: true,
      });
    },
    [navigate, activeCell],
  );
  const handleOpenLedger = useCallback(
    (filter: Record<string, string>) => {
      void navigate({
        search: (prev) => ({
          ...prev,
          // A project bucket is one exact project, while this URL-only scope
          // deliberately widens the Ledger to its descendants. Carrying it
          // through would make the drilldown no longer equal the aggregate.
          subprojects: filter.project ? undefined : prev.subprojects,
          // The date preset is a second way of describing the date range.
          // A Month bucket supplies exact bounds, so leave no stale preset
          // behind to expand differently when the Ledger restores URL state.
          date: filter.dateFrom || filter.dateTo ? undefined : prev.date,
          ...(filter.dateFrom || filter.dateTo
            ? { dateRelative: undefined }
            : {}),
          ...filter,
          view: "ledger" as const,
        }),
      });
    },
    [navigate],
  );

  if (isLoading || !data) {
    return (
      <Stack gap="lg">
        <ExpenseSummaryStrip loading />
        <Skeleton className="h-[300px] w-full" />
      </Stack>
    );
  }

  const {
    summary,
    adjustments,
    byCostType,
    tradeCostMatrix,
    monthly,
    cumulative,
    byProject,
    byVendor,
  } = data;

  return (
    <Stack gap="lg">
      <ExpenseSummaryStrip summary={summary} adjustmentsNet={adjustments.net} />

      <Section
        title="Analyze"
        description="Complete server-calculated buckets over the same filters as the Ledger. No raw rows are grouped in the browser."
      >
        <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
          <ExpenseAggregateExplorer
            filters={filters}
            config={analyzeConfig}
            onConfigChange={handleAnalyzeConfigChange}
            onOpenLedger={handleOpenLedger}
          />
        </Suspense>
      </Section>

      <Grid cols="pair">
        <Section
          title="Spending by Category"
          description={`Principal spend only; ${formatCurrency(adjustments.net, 0)} in purchase adjustments is included in Net above.`}
        >
          <CostTypeDonut
            byCostType={byCostType}
            selected={selectedCostType}
            onSelect={(key) =>
              setSelectedCostType((current) => (current === key ? null : key))
            }
          />
        </Section>
        <Section
          title="Spending by Trade"
          description={
            selectedCostType ? (
              <button
                type="button"
                className="underline underline-offset-2 transition-colors hover:text-foreground"
                onClick={() => setSelectedCostType(null)}
              >
                Clear selection
              </button>
            ) : (
              `Principal spend only; ${formatCurrency(adjustments.net, 0)} in purchase adjustments is included in Net above.`
            )
          }
        >
          <TradeBarsAggregate
            tradeCostMatrix={
              selectedCostType
                ? tradeCostMatrix.filter(
                    (row) => row.costType === selectedCostType,
                  )
                : tradeCostMatrix
            }
          />
        </Section>
      </Grid>

      <Section
        title="Trade × Cost Type"
        description={`Principal spend only; ${formatCurrency(adjustments.net, 0)} in purchase adjustments is included in Net. Click a cell to filter the Ledger view.`}
      >
        <TradeCostMatrixAggregate
          tradeCostMatrix={tradeCostMatrix}
          onCellClick={handleCellClick}
          activeCell={activeCell}
        />
      </Section>

      <Section
        title="Monthly Spend"
        description="Net spend per calendar month — recurring installments and spend rhythm show up as a repeating pattern. Negative months (refunds, credits) render below the axis."
      >
        <MonthlySpend monthly={monthly} />
      </Section>

      <Section
        title="Cumulative Spend"
        description="Running net total across the filtered set."
      >
        <CumulativeSpend cumulative={cumulative} />
      </Section>

      {byProject.length > 0 && (
        <Section title="By Project" description="Net spend per project.">
          <ProjectBreakdown byProject={byProject} />
        </Section>
      )}

      {byVendor.length > 0 && (
        <Section
          title="By Vendor"
          description="Net spend per vendor. Expenses with no vendor recorded are excluded, so these bars total less than Net above."
        >
          <VendorBreakdown byVendor={byVendor} />
        </Section>
      )}
    </Stack>
  );
}
