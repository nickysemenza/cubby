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

import { expenseContract } from "~/contracts/expense.contract";
import type { Database } from "~/server/db";
import {
  expenseAnalytics,
  expenseMonthlySummary,
  expenseTradeAffinity,
} from "~/server/domains/expense/repo/analytics";
import {
  buildExpenseAnalysisGrid,
  loadExpenseAnalysisCauses,
  loadExpenseAnalysisPeriod,
  loadExpenseFacetCounts,
  previousExpenseFilters,
  readyExpenseAnalysisOutput,
} from "~/server/domains/expense/repo/analyze";
import { loadVendorAttributionDefaults } from "~/server/domains/expense/repo/attribution-defaults";
import { getExpenseByID } from "~/server/domains/expense/repo/crud";
import { expenseList } from "~/server/domains/expense/repo/lookup";
import {
  buildExpenseWhereClause,
  resolveExpenseProjectAllocationScope,
} from "~/server/domains/expense/repo/lookup";
import { matchExpenses } from "~/server/domains/expense/repo/match";
import { loadEffectiveInventoryOwnershipById } from "~/server/domains/inventory/repo/ownership";
import { confirmInventoryExpenseBeneficiary } from "~/server/domains/inventory/repo/ownership-mutations";
import {
  getPurchaseExpenses,
  getPurchaseLinkIdentityByID,
} from "~/server/domains/purchase/repo/purchase";
import {
  mutationEvents,
  runMutationSideEffectsForEntities,
} from "~/server/entity-kernel/repo/mutation-side-effects";
import { listAll } from "~/server/generic/list/repo/list-all";
import {
  resolveLiveShortcode,
  resolveOrThrow,
} from "~/server/generic/shortcode/repo/shortcode-resolver";
import { TraceNames } from "~/server/observability/tracing";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import {
  bindWorkflow,
  tracedWorkflow,
  workflow,
} from "~/server/workflows/runtime";

export {
  expenseAnalyzeInput,
  expenseAnalyzeOut,
  expenseFacetCountsInput,
  expenseFacetCountsOut,
};

type ExpenseFilters = z.output<typeof expenseFiltersSchema>;

export const expenseChartDataWorkflow = async (
  db: Database,
  input: ExpenseFilters,
) =>
  (
    await listAll((pagination) =>
      expenseList(
        db,
        input,
        [{ orderBy: "date", direction: "asc" }],
        pagination,
      ),
    )
  ).data;

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
    buildExpenseWhereClause(context, input.filters, {
      projectScope: undefined,
    }),
  )
  .call("comparison", async (_, { input }) =>
    input.comparison === "previousPeriod"
      ? previousExpenseFilters(input.filters)
      : null,
  )
  .call("previousWhere", ({ context }, { comparison }) =>
    comparison
      ? buildExpenseWhereClause(context, comparison.filters, {
          projectScope: undefined,
        })
      : Promise.resolve(undefined),
  )
  .call("projectScope", ({ context }, { input }) =>
    resolveExpenseProjectAllocationScope(context, input.filters),
  )
  .parallel("periods", 2, {
    current: ({ context }, { input, currentWhere, projectScope }) =>
      loadExpenseAnalysisPeriod(
        context,
        currentWhere,
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
            previousWhere,
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
              input.periods.current.causes,
            ),
          previous: ({ context }, { input }) =>
            input.comparison
              ? loadExpenseAnalysisCauses(
                  context,
                  input.input,
                  input.previousWhere,
                  input.projectScope,
                  input.periods.previous?.causes,
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

export const expenseAnalyzeWorkflow = tracedWorkflow({
  name: TraceNames.service("expense", "analyze"),
  definition: expenseAnalyzeDefinition,
  attrs: expenseAnalyzeTraceAttributes,
});

const expenseFacetCountsDefinition = workflow<
  Database,
  ExpenseFacetCountsInput
>("expense.facetCounts")
  .call("facets", ({ context }, { input }) =>
    loadExpenseFacetCounts(context, input),
  )
  .output(({ facets }) => facets);

export const expenseFacetCountsWorkflow = tracedWorkflow({
  name: TraceNames.service("expense", "facetCounts"),
  definition: expenseFacetCountsDefinition,
  attrs: expenseFacetTraceAttributes,
});
async function expenseInventoryOwnershipContext(
  db: Database,
  input: z.output<typeof expenseInventoryOwnershipContextInput>,
) {
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
}

async function confirmInventoryBeneficiary(
  context: { db: Database; actorContext: ActorContext },
  input: z.output<typeof confirmInventoryExpenseBeneficiaryInput>,
) {
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
}

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
);

export const expenseHandlers = implementOperationDomain(expenseContract, {
  chartData: (context, input) => expenseChartDataWorkflow(context.db, input),
  analytics: (context, input) => expenseAnalytics(context.db, input),
  monthlySummary: (context, input) => expenseMonthlySummary(context.db, input),
  analyze: (context, input) => expenseAnalyzeWorkflow(context.db, input),
  facetCounts: (context, input) =>
    expenseFacetCountsWorkflow(context.db, input),
  tradeAffinity: (context) => expenseTradeAffinity(context.db),
  chargeContext: (context, input) =>
    expenseChargeContextWorkflow(context.db, input),
  inventoryOwnershipContext: (context, input) =>
    expenseInventoryOwnershipContext(context.db, input),
  vendorAttributionDefaults: (context, input) =>
    loadVendorAttributionDefaults(context.db, input.vendor),
  confirmInventoryBeneficiary: (context, input) =>
    confirmInventoryBeneficiary(context, input),
  match: (context, input) => matchExpenses(context.db, input),
});
