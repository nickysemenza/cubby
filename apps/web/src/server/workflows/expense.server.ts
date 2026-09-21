import type { ActorContext } from "@cubby/schemas/context";
import {
  type expenseShortcode,
  type PurchaseId,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import {
  confirmInventoryExpenseBeneficiaryInput,
  expenseInventoryOwnershipContextInput,
} from "@cubby/schemas/inventory-ownership";
import {
  expenseAnalyzeInput,
  expenseAnalyzeOut,
  expenseFacetCountsInput,
  expenseFacetCountsOut,
  expenseFiltersSchema,
} from "@cubby/schemas/project";
import type { z } from "zod";

import type { Database } from "~/server/db";
import {
  expenseAnalytics,
  expenseList,
  expenseMonthlySummary,
  expenseTradeAffinity,
  getExpenseByID,
  matchExpenses,
} from "~/server/repo/expense";
import {
  buildExpenseAnalysisGrid,
  expenseAnalysisWhere,
  includeSelectedExpenseFacetZeroOptions,
  isExpenseScalarFacet,
  loadExpenseAnalysisCauses,
  loadExpenseAnalysisPeriod,
  loadExpenseEntityFacetOptions,
  loadExpenseFacetWhere,
  loadExpenseOrderIdFacetOptions,
  loadExpensePresenceFacetOptions,
  loadExpenseScalarFacetOptions,
  previousExpenseFilters,
  readyExpenseAnalysisOutput,
  selectedExpenseFacetValues,
  type ExpenseFacetId,
} from "~/server/repo/expense/analyze";
import {
  buildExpenseWhereClause,
  resolveExpenseProjectAllocationScope,
} from "~/server/repo/expense/lookup";
import {
  confirmInventoryExpenseBeneficiary,
  loadEffectiveInventoryOwnershipById,
} from "~/server/repo/inventory";
import {
  getPurchaseExpenses,
  getPurchaseLinkIdentityByID,
} from "~/server/repo/purchase";
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/services/mutation-side-effects";
import { TraceNames, withTrace } from "~/server/tracing";
import {
  bindWorkflow,
  defineWorkflowOperation,
  executeWorkflow,
  workflow,
} from "~/server/workflow-runtime";

export {
  expenseAnalyzeInput,
  expenseAnalyzeOut,
  expenseFacetCountsInput,
  expenseFacetCountsOut,
};

const FETCH_ALL = { pageIndex: 0, pageSize: 100_000 } as const;

type ExpenseFilters = z.output<typeof expenseFiltersSchema>;

const expenseChartDataDefinition = workflow<Database, ExpenseFilters>(
  "expense.chartData",
)
  .call("list", ({ context }, { input }) =>
    expenseList(
      context,
      input,
      [{ orderBy: "date", direction: "asc" }],
      FETCH_ALL,
    ),
  )
  .output(({ list }) => list.data);
export const expenseChartDataWorkflow = bindWorkflow(
  expenseChartDataDefinition,
  (db: Database, input: ExpenseFilters) => ({ context: db, input }),
);
export const expenseAnalyticsWorkflow = defineWorkflowOperation(
  "expense.analytics",
  expenseAnalytics,
);
export const expenseMonthlySummaryWorkflow = defineWorkflowOperation(
  "expense.monthlySummary",
  expenseMonthlySummary,
);

type TraceAttributes = Record<string, string | number | boolean | undefined>;
export const expenseAnalyzeTraceAttributes = (
  input: z.output<typeof expenseAnalyzeInput>,
  result?: z.output<typeof expenseAnalyzeOut>,
) => {
  const request = {
    "expense.analyze.shape": input.columnDimension ? "2d" : "1d",
    "expense.analyze.row_dimension": input.rowDimension,
    "expense.analyze.column_dimension": input.columnDimension ?? "none",
    "expense.analyze.comparison": input.comparison,
  } satisfies TraceAttributes;
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
) => {
  const request = {
    "expense.facets.requested_ids": input.facetIds.join(","),
    "expense.facets.requested_count": input.facetIds.length,
  } satisfies TraceAttributes;
  if (!result) return request;
  return {
    ...request,
    "expense.facets.returned_count": result.facets.length,
    "expense.facets.option_count": result.facets.reduce(
      (total, facet) => total + facet.options.length,
      0,
    ),
  } satisfies TraceAttributes;
};

type ExpenseAnalyzeInput = z.output<typeof expenseAnalyzeInput>;
type ExpenseFacetCountsInput = z.output<typeof expenseFacetCountsInput>;

const expenseAnalyzeDefinition = workflow<Database, ExpenseAnalyzeInput>(
  "expense.analyze",
)
  .call("currentWhere", ({ context }, { input }) =>
    buildExpenseWhereClause(context, input.filters),
  )
  .call("comparison", async (_, { input }) =>
    input.comparison === "previousPeriod"
      ? previousExpenseFilters(input.filters)
      : null,
  )
  .call("previousWhere", ({ context }, { comparison }) =>
    comparison
      ? buildExpenseWhereClause(context, comparison.filters)
      : Promise.resolve(undefined),
  )
  .call("projectScope", ({ context }, { input }) =>
    resolveExpenseProjectAllocationScope(context, input.filters),
  )
  .parallel("periods", 2, {
    current: ({ context }, { input, currentWhere, projectScope }) =>
      loadExpenseAnalysisPeriod(
        context,
        expenseAnalysisWhere(currentWhere, input),
        currentWhere,
        input.rowDimension,
        input.columnDimension,
        projectScope,
      ),
    previous: (
      { context },
      { input, comparison, previousWhere, projectScope },
    ) =>
      comparison
        ? loadExpenseAnalysisPeriod(
            context,
            expenseAnalysisWhere(previousWhere, input),
            previousWhere,
            input.rowDimension,
            input.columnDimension,
            projectScope,
          )
        : Promise.resolve(null),
  })
  .call("grid", async (_, { input, comparison, periods }) =>
    buildExpenseAnalysisGrid(
      periods.current,
      periods.previous,
      comparison,
      input.columnDimension,
    ),
  )
  .branch("withinGridLimits", {
    when: async (_, { grid }) => grid.limitResult === null,
    whenTrue: (branch) =>
      branch
        .parallel("causes", 2, {
          current: ({ context }, { input }) =>
            loadExpenseAnalysisCauses(
              context,
              input.input,
              input.currentWhere,
              input.projectScope,
            ),
          previous: ({ context }, { input }) =>
            input.comparison
              ? loadExpenseAnalysisCauses(
                  context,
                  input.input,
                  input.previousWhere,
                  input.projectScope,
                )
              : Promise.resolve(null),
        })
        .output(({ input, causes }) =>
          readyExpenseAnalysisOutput(
            input.input,
            input.comparison,
            input.periods.current,
            input.periods.previous,
            input.grid,
            causes.current,
            causes.previous,
          ),
        ),
    whenFalse: (branch) =>
      branch.output(({ input }) => {
        if (!input.grid.limitResult)
          throw new Error("Limited expense analysis has no limit result");
        return input.grid.limitResult;
      }),
  })
  .output(({ withinGridLimits }) => withinGridLimits);

export const expenseAnalyzeWorkflow = Object.assign(
  (db: Database, input: ExpenseAnalyzeInput) =>
    withTrace(TraceNames.service("expense", "analyze"), async (span) => {
      span.setAttributes(expenseAnalyzeTraceAttributes(input));
      const result = await executeWorkflow(expenseAnalyzeDefinition, {
        context: db,
        input,
      });
      span.setAttributes(expenseAnalyzeTraceAttributes(input, result));
      return result;
    }),
  { definition: expenseAnalyzeDefinition },
);

type ExpenseFacetItemInput = {
  filters: ExpenseFilters;
  id: ExpenseFacetId;
};

const requireExpenseEntityFacet = (
  id: ExpenseFacetId,
): "project" | "vendor" => {
  if (id === "project" || id === "vendor") return id;
  throw new Error(`Expected entity facet, received ${id}`);
};

const expenseFacetItemDefinition = workflow<Database, ExpenseFacetItemInput>(
  "expense.facetCounts.facet",
)
  .call("where", ({ context }, { input }) =>
    loadExpenseFacetWhere(context, input.filters, input.id),
  )
  .branch("facetKind", {
    when: async (_, { input }) => isExpenseScalarFacet(input.id),
    whenTrue: (branch) =>
      branch
        .call("options", ({ context }, { input }) => {
          if (!isExpenseScalarFacet(input.input.id))
            throw new Error("Scalar facet branch received a non-scalar facet");
          return loadExpenseScalarFacetOptions(
            context,
            input.where,
            input.input.id,
          );
        })
        .output(({ input, options }) => ({ id: input.input.id, options })),
    whenFalse: (branch) =>
      branch
        .branch("entityFacet", {
          when: async (_, { input }) =>
            input.input.id === "project" || input.input.id === "vendor",
          whenTrue: (entityBranch) =>
            entityBranch
              .parallel("options", 2, {
                rows: ({ context }, { input }) =>
                  loadExpenseEntityFacetOptions(
                    context,
                    input.input.where,
                    requireExpenseEntityFacet(input.input.input.id),
                  ),
                presence: ({ context }, { input }) =>
                  loadExpensePresenceFacetOptions(
                    context,
                    input.input.where,
                    requireExpenseEntityFacet(input.input.input.id),
                  ),
              })
              .output(({ input, options }) => ({
                id: input.input.input.id,
                options: [...options.presence, ...options.rows],
              })),
          whenFalse: (orderBranch) =>
            orderBranch
              .call("options", ({ context }, { input }) =>
                loadExpenseOrderIdFacetOptions(context, input.input.where),
              )
              .output(({ input, options }) => ({
                id: input.input.input.id,
                options,
              })),
        })
        .output(({ entityFacet }) => entityFacet),
  })
  .output(({ facetKind }) => facetKind);

const expenseFacetCountsDefinition = workflow<
  Database,
  ExpenseFacetCountsInput
>("expense.facetCounts")
  .mapWorkflow("facets", {
    items: ({ input }) =>
      input.facetIds.map((id) => ({ filters: input.filters, id })),
    concurrency: 9,
    workflow: expenseFacetItemDefinition,
  })
  .output(({ input, facets }) => ({
    facets: facets.map((facet) => ({
      ...facet,
      options: includeSelectedExpenseFacetZeroOptions(
        facet.options,
        selectedExpenseFacetValues(input.filters, facet.id),
      ),
    })),
  }));

export const expenseFacetCountsWorkflow = Object.assign(
  (db: Database, input: ExpenseFacetCountsInput) =>
    withTrace(TraceNames.service("expense", "facetCounts"), async (span) => {
      span.setAttributes(expenseFacetTraceAttributes(input));
      const result = await executeWorkflow(expenseFacetCountsDefinition, {
        context: db,
        input,
      });
      span.setAttributes(expenseFacetTraceAttributes(input, result));
      return result;
    }),
  { definition: expenseFacetCountsDefinition },
);
export const expenseTradeAffinityWorkflow = defineWorkflowOperation(
  "expense.tradeAffinity",
  expenseTradeAffinity,
);

export const expenseInventoryOwnershipContextWorkflow = defineWorkflowOperation(
  "expense.inventoryOwnershipContext",
  async (
    db: Database,
    input: z.output<typeof expenseInventoryOwnershipContextInput>,
  ) => {
    const inventoryId = await resolveOrThrow(
      db,
      "inventory",
      input.inventoryEntryId,
    );
    const effectiveOwnership = await loadEffectiveInventoryOwnershipById(
      db,
      inventoryId,
    );
    if (!effectiveOwnership) {
      throw new Error("Resolved inventory entry disappeared");
    }
    return {
      inventoryEntryId: input.inventoryEntryId,
      effectiveOwnership,
      suggestedBeneficiaries: effectiveOwnership.effectiveOwner
        ? [{ partyId: effectiveOwnership.effectiveOwner.id, weight: 1 }]
        : [],
    };
  },
);

export const confirmInventoryExpenseBeneficiaryWorkflow =
  defineWorkflowOperation(
    "expense.confirmInventoryBeneficiary",
    async (
      context: { db: Database; actorContext: ActorContext },
      input: z.output<typeof confirmInventoryExpenseBeneficiaryInput>,
    ) => {
      const [inventoryId, expenseId] = await Promise.all([
        resolveOrThrow(context.db, "inventory", input.inventoryEntryId),
        resolveOrThrow(context.db, "expense", input.expenseId),
      ]);
      const result = await confirmInventoryExpenseBeneficiary(
        context.db,
        inventoryId,
        expenseId,
        input.evidenceFingerprint,
        context.actorContext,
      );
      await runMutationSideEffectsForEntities(
        context.db,
        mutationEvents(
          "expense",
          "updated",
          [expenseId],
          "expense.confirmInventoryBeneficiary",
        ),
      );
      return { expenseId: input.expenseId, ...result };
    },
  );

export const expenseMatchWorkflow = defineWorkflowOperation(
  "expense.match",
  matchExpenses,
);

type ChargeContextInput = z.output<typeof expenseShortcode>;
const requirePurchase = (id: PurchaseId | null): PurchaseId => {
  if (id === null)
    throw new Error("Charge-context purchase branch received null");
  return id;
};

export const expenseChargeContextWorkflow = bindWorkflow(
  workflow<Database, ChargeContextInput>("expense.chargeContext")
    .call("resolveExpense", ({ context }, { input }) =>
      resolveOrThrow(context, "expense", input),
    )
    .call("loadExpense", ({ context }, { resolveExpense }) =>
      getExpenseByID(context, resolveExpense),
    )
    .call("resolvePurchase", async ({ context }, { loadExpense }) => {
      if (!loadExpense.purchaseId) return null;
      const id = await resolveLiveShortcode(
        context,
        loadExpense.purchaseId,
        "purchase",
      );
      return id === null ? null : parseEntityId("purchase", id);
    })
    .branch("purchaseAvailable", {
      when: async (_, { resolvePurchase }) => resolvePurchase !== null,
      whenTrue: (branch) =>
        branch
          .parallel("chargeReads", 2, {
            purchase: ({ context }, { input: { resolvePurchase } }) =>
              getPurchaseLinkIdentityByID(
                context,
                requirePurchase(resolvePurchase),
              ),
            lines: ({ context }, { input: { resolvePurchase } }) =>
              getPurchaseExpenses(context, requirePurchase(resolvePurchase)),
          })
          .output(({ input, chargeReads }) =>
            chargeReads.purchase
              ? {
                  purchase: chargeReads.purchase,
                  siblings: chargeReads.lines.filter(
                    (row) => row.id !== input.input,
                  ),
                }
              : null,
          ),
      whenFalse: (branch) => branch.output(() => null),
    })
    .output(({ purchaseAvailable }) => purchaseAvailable),
  (db: Database, input: ChargeContextInput) => ({ context: db, input }),
);
