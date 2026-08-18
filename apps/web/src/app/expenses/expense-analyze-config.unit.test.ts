import { describe, expect, it } from "vitest";
import {
  canSwapExpenseAnalyzeAxes,
  DEFAULT_EXPENSE_ANALYZE_CONFIG,
  expenseAnalyzeConfigFromSearch,
  expenseAnalyzeSearchPatch,
  normalizeExpenseAnalyzeConfig,
  swapExpenseAnalyzeAxes,
} from "./expense-analyze-config";

const boundedDates = { dateFrom: "2026-08-01", dateTo: "2026-08-15" };

describe("expense Analyze URL configuration", () => {
  it("restores every shareable control and strips only default values", () => {
    const config = expenseAnalyzeConfigFromSearch({
      ...boundedDates,
      analyzeRows: "costType",
      analyzeColumns: "trade",
      analyzeMetric: "actual",
      analyzeCompare: "previousPeriod",
      analyzeShow: "delta",
    });

    expect(config).toEqual({
      rowDimension: "costType",
      columnDimension: "trade",
      metric: "actual",
      comparison: "previousPeriod",
      projection: "delta",
    });
    expect(expenseAnalyzeSearchPatch(config)).toEqual({
      analyzeRows: "costType",
      analyzeColumns: "trade",
      analyzeMetric: "actual",
      analyzeCompare: "previousPeriod",
      analyzeShow: "delta",
    });
    expect(expenseAnalyzeSearchPatch(DEFAULT_EXPENSE_ANALYZE_CONFIG)).toEqual({
      analyzeRows: undefined,
      analyzeColumns: undefined,
      analyzeMetric: undefined,
      analyzeCompare: undefined,
      analyzeShow: undefined,
    });
  });

  it("normalizes duplicate axes and comparisons that cannot be exact", () => {
    expect(
      expenseAnalyzeConfigFromSearch({
        analyzeRows: "trade",
        analyzeColumns: "trade",
        analyzeCompare: "previousPeriod",
        analyzeShow: "previous",
      }),
    ).toEqual(DEFAULT_EXPENSE_ANALYZE_CONFIG);

    expect(
      expenseAnalyzeConfigFromSearch({
        ...boundedDates,
        analyzeRows: "month",
        analyzeColumns: "trade",
        analyzeCompare: "previousPeriod",
        analyzeShow: "delta",
      }),
    ).toMatchObject({ comparison: "none", projection: "current" });
  });

  it("restores comparison from manifest-resolved preset dates", () => {
    expect(
      expenseAnalyzeConfigFromSearch(
        {
          analyzeRows: "trade",
          analyzeCompare: "previousPeriod",
        },
        boundedDates,
      ),
    ).toMatchObject({
      comparison: "previousPeriod",
    });
  });

  it("swaps only legal two-dimensional axes and preserves display choices", () => {
    const config = normalizeExpenseAnalyzeConfig(
      {
        rowDimension: "trade",
        columnDimension: "costType",
        metric: "credits",
        comparison: "previousPeriod",
        projection: "percent",
      },
      boundedDates,
    );
    expect(canSwapExpenseAnalyzeAxes(config)).toBe(true);
    expect(swapExpenseAnalyzeAxes(config, boundedDates)).toEqual({
      ...config,
      rowDimension: "costType",
      columnDimension: "trade",
    });

    const projectRows = { ...config, rowDimension: "project" as const };
    expect(canSwapExpenseAnalyzeAxes(projectRows)).toBe(false);
    expect(swapExpenseAnalyzeAxes(projectRows, boundedDates)).toBe(projectRows);
  });
});
