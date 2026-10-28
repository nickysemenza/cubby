import {
  type CostType,
  type ExpenseFilters,
  expenseFiltersSchema,
  type Trade,
} from "@cubby/schemas/project";
import { ChartBarIcon } from "@phosphor-icons/react/dist/csr/ChartBar";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { z } from "zod";

import { getEntityFilters } from "~/entity/filter-manifest";
import {
  buildFiltersFromManifest,
  filterGetterFromSearch,
  soleValue,
} from "~/entity/filters";
import { useEntityMetadata } from "~/entity/metadata";
import {
  type IndexedSection,
  IndexedSections,
  SectionStack,
} from "~/ui/data-table/indexed-sections";
import { useHydrated } from "~/ui/hooks/use-hydrated";
import { Stack } from "~/ui/layout";
import { Skeleton } from "~/ui/primitives/skeleton";
import {
  Visualization,
  visualizationState,
} from "~/ui/visualizations/visualization";

import { CostTypeDonut } from "./charts/cost-type-donut";
import { CumulativeSpend } from "./charts/cumulative-spend";
import { MoneyFlowSankey } from "./charts/money-flow-sankey";
import { MonthlySpend } from "./charts/monthly-spend";
import { ProjectBreakdown } from "./charts/project-breakdown";
import { SpendingCategoryBreakdown } from "./charts/spending-category-breakdown";
import type { AggregateMatrixCell } from "./charts/trade-cost-aggregate";
import {
  TradeBarsAggregate,
  TradeCostMatrixAggregate,
} from "./charts/trade-cost-aggregate";
import { VendorBreakdown } from "./charts/vendor-breakdown";
import {
  DEFAULT_EXPENSE_ANALYZE_CONFIG,
  type ExpenseAnalyzeConfig,
  expenseAnalyzeConfigFromSearch,
  expenseAnalyzeSearchFields,
  expenseAnalyzeSearchPatch,
  normalizeExpenseAnalyzeConfig,
} from "./expense-analyze-config";

const expenseAnalyzeSearchSchema = z.object(expenseAnalyzeSearchFields);
const dateSearch = (search: {
  date?: string;
  dateFrom?: string;
  dateTo?: string;
}) => ({ date: search.date, dateFrom: search.dateFrom, dateTo: search.dateTo });
import { expense } from "~/integrations/tanstack-query/generated/domains/expense.gen";

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

function parseExpenseFilters<TSearch extends {}>(
  queryClient: QueryClient,
  search: TSearch,
): ExpenseFilters {
  const specs = getEntityFilters(queryClient, "expense");
  return expenseFiltersSchema.parse(
    buildFiltersFromManifest(specs, filterGetterFromSearch(specs, search)),
  );
}

/**
 * `view=analytics` — chart-first read over `expense.analytics`'s
 * server-side aggregates (see packages/schemas/src/project.ts's
 * `expenseAnalyticsOut`).
 *
 * Filters are read straight off the route's URL search params through the
 * expense filter manifest — the SAME specs the ledger table syncs its column
 * filters through — so this view's totals always agree with the Ledger
 * view's, and a Trade × Cost Type matrix click here writes back to those same
 * params (switching to Ledger afterwards shows the matching rows).
 */
export function ExpenseAnalyticsView() {
  const queryClient = useQueryClient();
  useEntityMetadata("expense");
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const filters = useMemo(
    () => parseExpenseFilters(queryClient, search),
    [search, queryClient],
  );
  // The generated search carries the analyzer keys as plain strings (the
  // slot's `searchKeys`); the analyzer's own enums validate them here.
  const analyzeConfig = useMemo(
    () =>
      expenseAnalyzeConfigFromSearch(
        { ...expenseAnalyzeSearchSchema.parse(search), ...dateSearch(search) },
        filters,
      ),
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
    // oxlint-disable-next-line react/exhaustive-deps -- The fresh wrapper is intentionally excluded; stable semantic members and scalar keys govern this hook.
    [navigate, activeCell],
  );
  const handleOpenLedger = useCallback(
    (filter: Record<string, string>) => {
      void navigate({
        search: (prev) => ({
          ...prev,
          // A project bucket is one exact project; otherwise the Ledger
          // keeps the default sub-project subtree.
          includeSubProjects: filter.project
            ? "false"
            : prev.includeSubProjects,
          includeSubSpendingCategories: filter.spendingCategory
            ? "false"
            : prev.includeSubSpendingCategories,
          // Exact month bounds supersede a relative date preset.
          date: filter.dateFrom || filter.dateTo ? undefined : prev.date,
          ...filter,
          view: "table" as const,
        }),
      });
    },
    [navigate],
  );

  return (
    <ExpenseAnalytics
      filters={filters}
      analyzeConfig={analyzeConfig}
      onAnalyzeConfigChange={handleAnalyzeConfigChange}
      activeCell={activeCell}
      onCellClick={handleCellClick}
      onOpenLedger={handleOpenLedger}
    />
  );
}

/**
 * The same analytics over one project and its sub-project subtree. Drill-downs
 * open the Ledger with that project scope, so the rows behind a bucket are one
 * click away.
 */
export function ProjectExpenseAnalytics({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useEntityMetadata("expense");
  const scope = useMemo(() => ({ project: projectId }), [projectId]);
  const filters = useMemo(
    () => parseExpenseFilters(queryClient, scope),
    [scope, queryClient],
  );
  const [analyzeConfig, setAnalyzeConfig] = useState(
    DEFAULT_EXPENSE_ANALYZE_CONFIG,
  );
  const openLedger = useCallback(
    (filter: Record<string, string>) =>
      void navigate({
        to: "/expenses",
        search: {
          ...scope,
          includeSubProjects: filter.project ? "false" : undefined,
          includeSubSpendingCategories: filter.spendingCategory
            ? "false"
            : undefined,
          ...filter,
          view: "table",
        },
      }),
    [navigate, scope],
  );
  return (
    <ExpenseAnalytics
      embedded
      filters={filters}
      analyzeConfig={analyzeConfig}
      onAnalyzeConfigChange={(next) =>
        setAnalyzeConfig(normalizeExpenseAnalyzeConfig(next, filters))
      }
      activeCell={null}
      onCellClick={(trade, costType) =>
        openLedger(costType ? { trade, costType } : { trade })
      }
      onOpenLedger={openLedger}
    />
  );
}

function ExpenseAnalytics({
  embedded = false,
  filters,
  analyzeConfig,
  onAnalyzeConfigChange,
  activeCell,
  onCellClick,
  onOpenLedger,
}: {
  embedded?: boolean;
  filters: ExpenseFilters;
  analyzeConfig: ExpenseAnalyzeConfig;
  onAnalyzeConfigChange: (next: ExpenseAnalyzeConfig) => void;
  activeCell: AggregateMatrixCell | null;
  onCellClick: (trade: Trade, costType: CostType | null) => void;
  onOpenLedger: (filter: Record<string, string>) => void;
}) {
  const [selectedCostType, setSelectedCostType] = useState<string | null>(null);
  const hydrated = useHydrated();
  const query = useQuery(expense.analytics.queryOptions(filters));
  const data = hydrated ? query.data : undefined;
  const visualization = visualizationState({
    data,
    isLoading: !hydrated || query.isLoading,
    error: hydrated ? query.error : null,
    empty: data?.summary.count === 0,
    onRetry: () => void query.refetch(),
  });

  if (!data || visualization.status !== "ready") {
    return (
      <Visualization state={visualization} message="No expenses to analyze." />
    );
  }

  const {
    summary,
    byCostType,
    tradeCostMatrix,
    monthly,
    cumulative,
    byProject,
    byVendor,
  } = data;

  return (
    <Visualization state={visualization}>
      <Stack gap="lg">
        <ExpenseSummaryStrip
          basis={
            filters.projectId || filters.projectPresenceFilter
              ? "allocation"
              : "ledger"
          }
          summary={summary}
        />

        <ExpenseAnalyticsSections
          embedded={embedded}
          sections={[
            {
              id: "analyze",
              icon: ChartBarIcon,
              overflowVisible: true,
              title: "Analyze",
              description:
                "Complete server-calculated buckets over the same filters as the Ledger. No raw rows are grouped in the browser.",
              content: (
                <Suspense fallback={<Skeleton className="h-[300px] w-full" />}>
                  <ExpenseAggregateExplorer
                    filters={filters}
                    config={analyzeConfig}
                    onConfigChange={onAnalyzeConfigChange}
                    onOpenLedger={onOpenLedger}
                  />
                </Suspense>
              ),
            },
            {
              id: "spending-category",
              icon: ChartBarIcon,
              overflowVisible: true,
              title: "Spending by Spending Category",
              description:
                "Net per root category. Tax, shipping, and fees follow the items they were charged on; Uncategorized and Unclassified close the total. Click a bar to open its rows in the Ledger.",
              content: (
                <SpendingCategoryBreakdown
                  filters={filters}
                  onOpenLedger={onOpenLedger}
                />
              ),
            },
            {
              id: "cost-type",
              icon: ChartBarIcon,
              overflowVisible: true,
              title: "Spending by Cost Type",
              description:
                "Tax, shipping, and fees follow the items they were charged on.",
              content: (
                <CostTypeDonut
                  byCostType={byCostType}
                  selected={selectedCostType}
                  onSelect={(key) =>
                    setSelectedCostType((current) =>
                      current === key ? null : key,
                    )
                  }
                />
              ),
            },
            {
              id: "trade",
              icon: ChartBarIcon,
              overflowVisible: true,
              title: "Spending by Trade",
              description: selectedCostType ? (
                <button
                  type="button"
                  className="underline underline-offset-2 transition-colors hover:text-foreground"
                  onClick={() => setSelectedCostType(null)}
                >
                  Clear selection
                </button>
              ) : (
                "Tax, shipping, and fees follow the items they were charged on."
              ),
              content: (
                <TradeBarsAggregate
                  tradeCostMatrix={
                    selectedCostType
                      ? tradeCostMatrix.filter(
                          (row) => row.costType === selectedCostType,
                        )
                      : tradeCostMatrix
                  }
                />
              ),
            },
            {
              id: "trade-cost-type",
              icon: ChartBarIcon,
              overflowVisible: true,
              title: "Trade × Cost Type",
              description:
                "Tax, shipping, and fees follow the items they were charged on. Click a cell to filter the Ledger view.",
              content: (
                <TradeCostMatrixAggregate
                  tradeCostMatrix={tradeCostMatrix}
                  onCellClick={onCellClick}
                  activeCell={activeCell}
                />
              ),
            },
            {
              id: "monthly-spend",
              icon: ChartBarIcon,
              overflowVisible: true,
              title: "Monthly Spend",
              description:
                "Net spend per calendar month — recurring installments and spend rhythm show up as a repeating pattern. Negative months (refunds, credits) render below the axis.",
              content: <MonthlySpend monthly={monthly} />,
            },
            {
              id: "cumulative-spend",
              icon: ChartBarIcon,
              overflowVisible: true,
              title: "Cumulative Spend",
              description: "Running net total across the filtered set.",
              content: <CumulativeSpend cumulative={cumulative} />,
            },
            {
              id: "money-flow",
              icon: ChartBarIcon,
              overflowVisible: true,
              title: "Money flow",
              description:
                "Who paid, through which project, into which root category. Net per path; Credits net inside their path. Click a band to open its rows in the Ledger.",
              content: (
                <MoneyFlowSankey
                  filters={filters}
                  onOpenLedger={onOpenLedger}
                />
              ),
            },
            {
              id: "by-project",
              icon: ChartBarIcon,
              overflowVisible: true,
              title: "By Project",
              description: "Net spend per project.",
              content: <ProjectBreakdown byProject={byProject} />,
            },
            {
              id: "by-vendor",
              icon: ChartBarIcon,
              overflowVisible: true,
              title: "By Vendor",
              description:
                "Net spend per vendor. Expenses with no vendor recorded are excluded, so these bars total less than Net above.",
              content: <VendorBreakdown byVendor={byVendor} />,
            },
          ]}
        />
      </Stack>
    </Visualization>
  );
}

/** Record slots keep the record's existing contents rail. */
function ExpenseAnalyticsSections({
  sections,
  embedded,
}: {
  sections: IndexedSection[];
  embedded: boolean;
}) {
  return embedded ? (
    <SectionStack sections={sections} />
  ) : (
    <IndexedSections
      groups={[
        { id: "detail-group-analytics", title: "Expense analytics", sections },
      ]}
    />
  );
}
