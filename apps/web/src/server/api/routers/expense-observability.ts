import type {
  ExpenseAnalyzeInput,
  ExpenseAnalyzeOut,
  ExpenseFacetCountsInput,
  ExpenseFacetCountsOut,
} from "@cubby/schemas/project";
import { sumBy } from "es-toolkit";

type TraceAttributes = Record<string, string | number | boolean | undefined>;

/** Bounded, non-sensitive analyzer attributes for the semantic service span. */
export function expenseAnalyzeTraceAttributes(
  input: ExpenseAnalyzeInput,
  result?: ExpenseAnalyzeOut,
): TraceAttributes {
  const request = {
    "expense.analyze.shape": input.columnDimension ? "2d" : "1d",
    "expense.analyze.row_dimension": input.rowDimension,
    "expense.analyze.column_dimension": input.columnDimension ?? "none",
    "expense.analyze.comparison": input.comparison,
  };
  if (!result) return request;
  if (result.status === "ready") {
    return {
      ...request,
      "expense.analyze.status": result.status,
      "expense.analyze.row_count": result.rows.length,
      "expense.analyze.column_count": result.columns.length,
      "expense.analyze.cell_count": result.cells.length,
    };
  }
  return {
    ...request,
    "expense.analyze.status": result.status,
    "expense.analyze.limit_reason": result.reason,
    "expense.analyze.limit": result.limit,
    "expense.analyze.observed_at_least": result.observedAtLeast,
  };
}

/** Bounded facet shape only; filter values and option labels never enter spans. */
export function expenseFacetTraceAttributes(
  input: ExpenseFacetCountsInput,
  result?: ExpenseFacetCountsOut,
): TraceAttributes {
  const request = {
    "expense.facets.requested_ids": input.facetIds.join(","),
    "expense.facets.requested_count": input.facetIds.length,
  };
  if (!result) return request;
  return {
    ...request,
    "expense.facets.returned_count": result.facets.length,
    "expense.facets.option_count": sumBy(
      result.facets,
      (facet) => facet.options.length,
    ),
  };
}
