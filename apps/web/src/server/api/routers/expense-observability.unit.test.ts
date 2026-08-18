import type {
  ExpenseAnalyzeInput,
  ExpenseAnalyzeOut,
  ExpenseFacetCountsInput,
  ExpenseFacetCountsOut,
} from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";
import {
  expenseAnalyzeTraceAttributes,
  expenseFacetTraceAttributes,
} from "./expense-observability";

const input: ExpenseAnalyzeInput = {
  filters: { search: "private household search" },
  rowDimension: "trade",
  columnDimension: "costType",
  comparison: "none",
};

describe("Expense analysis observability", () => {
  it("records bounded result shape without filter values", () => {
    const result = {
      status: "ready",
      rowDimension: "trade",
      columnDimension: "costType",
      comparison: { mode: "none", previousRange: null },
      rows: [],
      columns: [],
      cells: [],
      totals: {
        scope: {
          current: { actual: 0, committed: 0, credits: 0, net: 0, count: 0 },
          previous: null,
        },
        grid: {
          current: { actual: 0, committed: 0, credits: 0, net: 0, count: 0 },
          previous: null,
        },
      },
      reconciliation: {
        tail: {
          current: { actual: 0, committed: 0, credits: 0, net: 0, count: 0 },
          previous: null,
        },
        causes: {
          adjustments: {
            current: {
              actual: 0,
              committed: 0,
              credits: 0,
              net: 0,
              count: 0,
            },
            previous: null,
          },
          unattributedProject: {
            current: {
              actual: 0,
              committed: 0,
              credits: 0,
              net: 0,
              count: 0,
            },
            previous: null,
          },
          unattributedVendor: {
            current: {
              actual: 0,
              committed: 0,
              credits: 0,
              net: 0,
              count: 0,
            },
            previous: null,
          },
        },
      },
    } satisfies ExpenseAnalyzeOut;

    const attributes = expenseAnalyzeTraceAttributes(input, result);
    expect(attributes).toEqual({
      "expense.analyze.shape": "2d",
      "expense.analyze.row_dimension": "trade",
      "expense.analyze.column_dimension": "costType",
      "expense.analyze.comparison": "none",
      "expense.analyze.status": "ready",
      "expense.analyze.row_count": 0,
      "expense.analyze.column_count": 0,
      "expense.analyze.cell_count": 0,
    });
    expect(JSON.stringify(attributes)).not.toContain("private household");
  });

  it("records hard-limit outcomes and aggregate facet cardinality", () => {
    const tooLarge = {
      status: "too_large",
      reason: "cell_limit",
      limit: 1_000,
      observedAtLeast: 1_001,
    } satisfies ExpenseAnalyzeOut;
    expect(expenseAnalyzeTraceAttributes(input, tooLarge)).toMatchObject({
      "expense.analyze.status": "too_large",
      "expense.analyze.limit_reason": "cell_limit",
      "expense.analyze.limit": 1_000,
      "expense.analyze.observed_at_least": 1_001,
    });

    const facetInput = {
      filters: { search: "still private" },
      facetIds: ["trade", "project"],
    } satisfies ExpenseFacetCountsInput;
    const facetResult = {
      facets: [
        { id: "trade", options: [{ value: "other", label: null, count: 2 }] },
        {
          id: "project",
          options: [
            { value: "PRJ-2345", label: "Kitchen", count: 1 },
            { value: "__none__", label: null, count: 1 },
          ],
        },
      ],
    } satisfies ExpenseFacetCountsOut;
    const attributes = expenseFacetTraceAttributes(facetInput, facetResult);
    expect(attributes).toEqual({
      "expense.facets.requested_ids": "trade,project",
      "expense.facets.requested_count": 2,
      "expense.facets.returned_count": 2,
      "expense.facets.option_count": 3,
    });
    expect(JSON.stringify(attributes)).not.toContain("still private");
  });
});
