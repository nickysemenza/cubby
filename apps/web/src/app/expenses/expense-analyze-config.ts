import {
  type ExpenseAnalyzeColumnDimension,
  type ExpenseAnalyzeComparison,
  type ExpenseAnalyzeRowDimension,
  expenseAnalyzeColumnDimensionSchema,
  expenseAnalyzeComparisonSchema,
  expenseAnalyzeRowDimensionSchema,
} from "@cubby/schemas/project";
import { z } from "zod";

const expenseAnalyzeMetricSchema = z.enum([
  "net",
  "actual",
  "committed",
  "credits",
  "count",
]);
export type ExpenseAnalyzeMetric = z.infer<typeof expenseAnalyzeMetricSchema>;

const expenseAnalyzeProjectionSchema = z.enum([
  "current",
  "previous",
  "delta",
  "percent",
]);
export type ExpenseAnalyzeProjection = z.infer<
  typeof expenseAnalyzeProjectionSchema
>;

/** Route-owned analyzer search fields. Domain filters remain in the manifest. */
export const expenseAnalyzeSearchFields = {
  analyzeRows: expenseAnalyzeRowDimensionSchema.optional().catch(undefined),
  analyzeColumns: expenseAnalyzeColumnDimensionSchema
    .optional()
    .catch(undefined),
  analyzeMetric: expenseAnalyzeMetricSchema.optional().catch(undefined),
  analyzeCompare: expenseAnalyzeComparisonSchema.optional().catch(undefined),
  analyzeShow: expenseAnalyzeProjectionSchema.optional().catch(undefined),
} as const;

export interface ExpenseAnalyzeConfig {
  rowDimension: ExpenseAnalyzeRowDimension;
  columnDimension: ExpenseAnalyzeColumnDimension | null;
  metric: ExpenseAnalyzeMetric;
  comparison: ExpenseAnalyzeComparison;
  projection: ExpenseAnalyzeProjection;
}

export const DEFAULT_EXPENSE_ANALYZE_CONFIG: ExpenseAnalyzeConfig = {
  rowDimension: "trade",
  columnDimension: null,
  metric: "net",
  comparison: "none",
  projection: "current",
};

interface ExpenseAnalyzeSearchLike {
  analyzeRows?: ExpenseAnalyzeRowDimension;
  analyzeColumns?: ExpenseAnalyzeColumnDimension;
  analyzeMetric?: ExpenseAnalyzeMetric;
  analyzeCompare?: ExpenseAnalyzeComparison;
  analyzeShow?: ExpenseAnalyzeProjection;
  dateFrom?: string;
  dateTo?: string;
}

const isColumnDimension = (
  dimension: ExpenseAnalyzeRowDimension,
): dimension is ExpenseAnalyzeColumnDimension =>
  dimension === "trade" || dimension === "costType" || dimension === "month";

export function normalizeExpenseAnalyzeConfig(
  config: ExpenseAnalyzeConfig,
  dates: Pick<ExpenseAnalyzeSearchLike, "dateFrom" | "dateTo">,
): ExpenseAnalyzeConfig {
  const columnDimension =
    config.columnDimension === config.rowDimension
      ? null
      : config.columnDimension;
  const comparisonAllowed = Boolean(
    dates.dateFrom &&
      dates.dateTo &&
      config.rowDimension !== "month" &&
      columnDimension !== "month",
  );
  const comparison = comparisonAllowed ? config.comparison : "none";
  const projection =
    columnDimension && comparison === "previousPeriod"
      ? config.projection
      : "current";

  return {
    ...config,
    columnDimension,
    comparison,
    projection,
  };
}

export function expenseAnalyzeConfigFromSearch(
  search: ExpenseAnalyzeSearchLike,
): ExpenseAnalyzeConfig {
  return normalizeExpenseAnalyzeConfig(
    {
      rowDimension:
        search.analyzeRows ?? DEFAULT_EXPENSE_ANALYZE_CONFIG.rowDimension,
      columnDimension: search.analyzeColumns ?? null,
      metric: search.analyzeMetric ?? DEFAULT_EXPENSE_ANALYZE_CONFIG.metric,
      comparison:
        search.analyzeCompare ?? DEFAULT_EXPENSE_ANALYZE_CONFIG.comparison,
      projection:
        search.analyzeShow ?? DEFAULT_EXPENSE_ANALYZE_CONFIG.projection,
    },
    search,
  );
}

/** Canonical patch: defaults and inapplicable state disappear from the URL. */
export function expenseAnalyzeSearchPatch(config: ExpenseAnalyzeConfig) {
  return {
    analyzeRows:
      config.rowDimension === DEFAULT_EXPENSE_ANALYZE_CONFIG.rowDimension
        ? undefined
        : config.rowDimension,
    analyzeColumns: config.columnDimension ?? undefined,
    analyzeMetric:
      config.metric === DEFAULT_EXPENSE_ANALYZE_CONFIG.metric
        ? undefined
        : config.metric,
    analyzeCompare:
      config.comparison === DEFAULT_EXPENSE_ANALYZE_CONFIG.comparison
        ? undefined
        : config.comparison,
    analyzeShow:
      config.projection === DEFAULT_EXPENSE_ANALYZE_CONFIG.projection
        ? undefined
        : config.projection,
  };
}

export function canSwapExpenseAnalyzeAxes(config: ExpenseAnalyzeConfig) {
  return (
    config.columnDimension !== null && isColumnDimension(config.rowDimension)
  );
}

export function swapExpenseAnalyzeAxes(
  config: ExpenseAnalyzeConfig,
  dates: Pick<ExpenseAnalyzeSearchLike, "dateFrom" | "dateTo">,
): ExpenseAnalyzeConfig {
  if (!config.columnDimension || !isColumnDimension(config.rowDimension)) {
    return config;
  }
  return normalizeExpenseAnalyzeConfig(
    {
      ...config,
      rowDimension: config.columnDimension,
      columnDimension: config.rowDimension,
    },
    dates,
  );
}
