import {
  type expenseShortcode,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import {
  expenseAnalyzeInput,
  expenseAnalyzeOut,
  expenseFacetCountsInput,
  expenseFacetCountsOut,
  expenseFiltersSchema,
  expenseMatchInput,
} from "@cubby/schemas/project";
import type { z } from "zod";
import type { Database } from "~/server/db";
import {
  expenseAnalytics,
  expenseAnalyze,
  expenseFacetCounts,
  expenseList,
  expenseMonthlySummary,
  expenseTradeAffinity,
  getExpenseByID,
  matchExpenses,
} from "~/server/repo/expense";
import {
  getPurchaseExpenses,
  getPurchaseLinkIdentityByID,
} from "~/server/repo/purchase";
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import { TraceNames, withTrace } from "~/server/tracing";

export {
  expenseAnalyzeInput,
  expenseAnalyzeOut,
  expenseFacetCountsInput,
  expenseFacetCountsOut,
  expenseFiltersSchema,
  expenseMatchInput,
};

const FETCH_ALL = { pageIndex: 0, pageSize: 100_000 } as const;

export const expenseChartDataWorkflow = async (
  db: Database,
  input: z.output<typeof expenseFiltersSchema>,
) =>
  (
    await expenseList(
      db,
      input,
      [{ orderBy: "date", direction: "asc" }],
      FETCH_ALL,
    )
  ).data;
export const expenseAnalyticsWorkflow = (
  db: Database,
  input: z.output<typeof expenseFiltersSchema>,
) => expenseAnalytics(db, input);
export const expenseMonthlySummaryWorkflow = (
  db: Database,
  input: z.output<typeof expenseFiltersSchema>,
) => expenseMonthlySummary(db, input);

type TraceAttributes = Record<string, string | number | boolean | undefined>;
export const expenseAnalyzeTraceAttributes = (
  input: z.output<typeof expenseAnalyzeInput>,
  result?: z.output<typeof expenseAnalyzeOut>,
): TraceAttributes => {
  const request = {
    "expense.analyze.shape": input.columnDimension ? "2d" : "1d",
    "expense.analyze.row_dimension": input.rowDimension,
    "expense.analyze.column_dimension": input.columnDimension ?? "none",
    "expense.analyze.comparison": input.comparison,
  };
  if (!result) return request;
  return result.status === "ready"
    ? {
        ...request,
        "expense.analyze.status": result.status,
        "expense.analyze.row_count": result.rows.length,
        "expense.analyze.column_count": result.columns.length,
        "expense.analyze.cell_count": result.cells.length,
      }
    : {
        ...request,
        "expense.analyze.status": result.status,
        "expense.analyze.limit_reason": result.reason,
        "expense.analyze.limit": result.limit,
        "expense.analyze.observed_at_least": result.observedAtLeast,
      };
};
export const expenseFacetTraceAttributes = (
  input: z.output<typeof expenseFacetCountsInput>,
  result?: z.output<typeof expenseFacetCountsOut>,
): TraceAttributes => ({
  "expense.facets.requested_ids": input.facetIds.join(","),
  "expense.facets.requested_count": input.facetIds.length,
  ...(result
    ? {
        "expense.facets.returned_count": result.facets.length,
        "expense.facets.option_count": result.facets.reduce(
          (total, facet) => total + facet.options.length,
          0,
        ),
      }
    : {}),
});

export const expenseAnalyzeWorkflow = (
  db: Database,
  input: z.output<typeof expenseAnalyzeInput>,
) =>
  withTrace(TraceNames.service("expense", "analyze"), async (span) => {
    span.setAttributes(expenseAnalyzeTraceAttributes(input));
    const result = await expenseAnalyze(db, input);
    span.setAttributes(expenseAnalyzeTraceAttributes(input, result));
    return result;
  });
export const expenseFacetCountsWorkflow = (
  db: Database,
  input: z.output<typeof expenseFacetCountsInput>,
) =>
  withTrace(TraceNames.service("expense", "facetCounts"), async (span) => {
    span.setAttributes(expenseFacetTraceAttributes(input));
    const result = await expenseFacetCounts(db, input);
    span.setAttributes(expenseFacetTraceAttributes(input, result));
    return result;
  });
export const expenseTradeAffinityWorkflow = (db: Database) =>
  expenseTradeAffinity(db);
export const expenseMatchWorkflow = (
  db: Database,
  input: z.output<typeof expenseMatchInput>,
) => matchExpenses(db, input);

export const expenseChargeContextWorkflow = async (
  db: Database,
  input: z.output<typeof expenseShortcode>,
) => {
  const id = await resolveOrThrow(db, "expense", input);
  const self = await getExpenseByID(db, id);
  if (!self.purchaseId) return null;
  const purchaseId = await resolveLiveShortcode(
    db,
    self.purchaseId,
    "purchase",
  );
  if (!purchaseId) return null;
  const purchaseUuid = parseEntityId("purchase", purchaseId);
  const [purchase, lines] = await Promise.all([
    getPurchaseLinkIdentityByID(db, purchaseUuid),
    getPurchaseExpenses(db, purchaseUuid),
  ]);
  if (!purchase) return null;
  return { purchase, siblings: lines.filter((row) => row.id !== input) };
};
