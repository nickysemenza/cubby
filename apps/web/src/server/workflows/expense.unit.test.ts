import type {
  ExpenseAnalyzeInput,
  ExpenseAnalyzeOut,
  ExpenseFacetCountsInput,
  ExpenseFacetCountsOut,
} from "@cubby/schemas/project";
import { describe, expect, it } from "vitest";

import { inspectWorkflow } from "~/server/workflow-runtime";

import {
  expenseAnalyzeTraceAttributes,
  expenseAnalyzeWorkflow,
  expenseChargeContextWorkflow,
  expenseChartDataWorkflow,
  expenseFacetCountsWorkflow,
  expenseFacetTraceAttributes,
} from "./expense.server";

const input: ExpenseAnalyzeInput = {
  filters: { search: "private household search" },
  rowDimension: "trade",
  columnDimension: "costType",
  comparison: "none",
};

const expectAnalyzerGraph = () => {
  expect(inspectWorkflow(expenseChartDataWorkflow.definition)).toMatchObject({
    name: "expense.chartData",
    steps: [{ type: "call", name: "list", dependencies: ["$input"] }],
  });
  const analysis = inspectWorkflow(expenseAnalyzeWorkflow.definition);
  expect(analysis.steps.map(({ type, name }) => ({ type, name }))).toEqual([
    { type: "call", name: "currentWhere" },
    { type: "call", name: "comparison" },
    { type: "call", name: "previousWhere" },
    { type: "call", name: "projectScope" },
    { type: "parallel", name: "periods" },
    { type: "call", name: "grid" },
    { type: "branch", name: "withinGridLimits" },
  ]);
  expect(analysis.steps[4]?.branches).toMatchObject({
    current: { name: "current" },
    previous: { name: "previous" },
  });
  expect(analysis.steps[6]?.branches?.whenTrue?.steps).toMatchObject([
    { type: "parallel", name: "causes", concurrency: 2 },
  ]);
  expect(analysis.steps[6]?.branches?.whenFalse?.steps).toEqual([]);
};

const expectFacetGraph = () => {
  const facets = inspectWorkflow(expenseFacetCountsWorkflow.definition);
  const map = facets.steps[0];
  expect(map).toMatchObject({ type: "map", name: "facets", concurrency: 9 });
  if (!map || map.type !== "map") throw new Error("Facet graph lacks map");
  const item = map.branches?.item;
  if (!item) throw new Error("Facet graph lacks mapped item workflow");
  const itemSteps = item.steps;
  expect(itemSteps).toMatchObject([
    { type: "call", name: "where" },
    { type: "branch", name: "facetKind" },
  ]);
  const kind = itemSteps[1];
  if (!kind || kind.type !== "branch")
    throw new Error("Facet graph lacks kind branch");
  const otherwise = kind.branches?.whenFalse;
  if (!otherwise) throw new Error("Facet graph lacks non-scalar branch");
  expect(otherwise.steps).toMatchObject([
    { type: "branch", name: "entityFacet" },
  ]);
};

const expectChargeContextGraph = () => {
  const chargeContext = inspectWorkflow(
    expenseChargeContextWorkflow.definition,
  );
  expect(chargeContext.steps.map(({ type, name }) => ({ type, name }))).toEqual(
    [
      { type: "call", name: "resolveExpense" },
      { type: "call", name: "loadExpense" },
      { type: "call", name: "resolvePurchase" },
      { type: "branch", name: "purchaseAvailable" },
    ],
  );
  expect(chargeContext.steps[3]?.branches?.whenTrue?.steps).toMatchObject([
    {
      type: "parallel",
      name: "chargeReads",
      concurrency: 2,
      branches: {
        purchase: { name: "purchase" },
        lines: { name: "lines" },
      },
    },
  ]);
  expect(chargeContext.steps[3]?.branches?.whenFalse?.steps).toEqual([]);
};

describe("expense workflow observability", () => {
  it("exposes direct and branched application workflow graphs", () => {
    expect.hasAssertions();
    expectAnalyzerGraph();
    expectFacetGraph();
    expectChargeContextGraph();
  });

  it("records bounded result shape without filter values", () => {
    const zero = { actual: 0, committed: 0, credits: 0, net: 0, count: 0 };
    const result = {
      status: "ready",
      rowDimension: "trade",
      columnDimension: "costType",
      comparison: { mode: "none", previousRange: null },
      rows: [],
      columns: [],
      cells: [],
      totals: {
        scope: { current: zero, previous: null },
        grid: { current: zero, previous: null },
      },
      reconciliation: {
        tail: { current: zero, previous: null },
        causes: {
          adjustments: { current: zero, previous: null },
          unattributedProject: { current: zero, previous: null },
          unattributedVendor: { current: zero, previous: null },
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
