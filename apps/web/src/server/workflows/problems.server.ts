import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  coverageTotalsSchema,
  deleteUnusedIngredientsInput,
  deleteUnusedIngredientsOut,
  dryRunPruneAliasesOut,
  dryRunReparseOut,
  maintenanceCountsSchema,
  problemsCountSchema,
  problemsCoverageSchema,
  problemsFastSchema,
  problemsTrackerSchema,
  problemsUpcSchema,
  problemsViewsSchema,
  recipeUsageByProductInput,
  recipeUsageByProductOut,
  resolveArrivedFindingsInput,
  resolveArrivedFindingsOut,
  resolveImportFindingInput,
  resolveImportFindingOut,
  PROBLEM_CLASS,
  type ProblemKey,
} from "@cubby/schemas/problems";
import { z } from "zod";

import {
  resolveArrivedFindingsForPurchase,
  resolveImportFinding,
} from "~/server/purchase-import/findings";
import { recipeUsageCountsByProduct } from "~/server/repo/problems";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";
import {
  findAllViewProblemIds,
  findViewProblems,
} from "~/server/services/problem-views.service";
import {
  deleteUnusedIngredients,
  dryRunPruneAliases,
  dryRunReparse,
  findCoverageProblems,
  findCoverageTotals,
  findFastProblems,
  findMaintenanceCounts,
  findProblemByType,
  findTrackerProblems,
  findUpcProblems,
  selectIngredientsWithUnusedAliases,
  selectStaleIngredientParses,
  pruneUnusedIngredientAliasesBatch,
  reparseStaleIngredientParsesBatch,
} from "~/server/services/problems.service";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import {
  bindWorkflow,
  bindCoordinatorStream,
  defineCoordinatorStream,
  defineWorkflowOperation,
  workflow,
} from "~/server/workflow-runtime";

export type ProblemsWorkflowContext = Pick<
  AuthenticatedStartOperationContext,
  "db" | "upcLookupClient" | "usdaClient" | "actorContext" | "services"
>;

const problemKeySchema = z.custom<ProblemKey>(
  (value): value is ProblemKey =>
    typeof value === "string" && Object.hasOwn(PROBLEM_CLASS, value),
);
const problemByTypeSchema = z.object({
  type: problemKeySchema,
  items: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
});
const noInput = z.undefined();
const problemsWorkflowSchemas = {
  getFast: { input: noInput, output: problemsFastSchema },
  getCounts: { input: noInput, output: problemsCountSchema },
  getByType: {
    input: z.object({ key: problemKeySchema }),
    output: problemByTypeSchema,
  },
  getViews: { input: noInput, output: problemsViewsSchema },
  getCoverage: { input: noInput, output: problemsCoverageSchema },
  getUpc: { input: noInput, output: problemsUpcSchema },
  getTracker: { input: noInput, output: problemsTrackerSchema },
  getCoverageTotals: { input: noInput, output: coverageTotalsSchema },
  getMaintenanceCounts: { input: noInput, output: maintenanceCountsSchema },
  dryRunReparse: { input: noInput, output: dryRunReparseOut },
  dryRunPruneAliases: { input: noInput, output: dryRunPruneAliasesOut },
  recipeUsageByProduct: {
    input: recipeUsageByProductInput,
    output: recipeUsageByProductOut,
  },
  deleteUnused: {
    input: deleteUnusedIngredientsInput,
    output: deleteUnusedIngredientsOut,
  },
  resolveImportFinding: {
    input: resolveImportFindingInput,
    output: resolveImportFindingOut,
  },
  resolveArrivedFindings: {
    input: resolveArrivedFindingsInput,
    output: resolveArrivedFindingsOut,
  },
};

export const findFastProblemsWorkflow = defineWorkflowOperation(
  "problems.getFast",
  (c: ProblemsWorkflowContext) => findFastProblems(c.db),
);

export const findProblemByTypeWorkflow = defineWorkflowOperation(
  "problems.getByType",
  (
    c: ProblemsWorkflowContext,
    input: z.output<typeof problemsWorkflowSchemas.getByType.input>,
  ) => findProblemByType(c.db, input.key, c.upcLookupClient, c.usdaClient),
);
export const findViewProblemsWorkflow = defineWorkflowOperation(
  "problems.getViews",
  (c: ProblemsWorkflowContext) => findViewProblems(c.db),
);
export const findCoverageProblemsWorkflow = defineWorkflowOperation(
  "problems.getCoverage",
  (c: ProblemsWorkflowContext) => findCoverageProblems(c.db, c.usdaClient),
);
export const findUpcProblemsWorkflow = defineWorkflowOperation(
  "problems.getUpc",
  (c: ProblemsWorkflowContext) => findUpcProblems(c.db, c.upcLookupClient),
);
export const findTrackerProblemsWorkflow = defineWorkflowOperation(
  "problems.getTracker",
  (c: ProblemsWorkflowContext) => findTrackerProblems(c.db),
);
export const findCoverageTotalsWorkflow = defineWorkflowOperation(
  "problems.getCoverageTotals",
  (c: ProblemsWorkflowContext) => findCoverageTotals(c.db),
);
export const findMaintenanceCountsWorkflow = defineWorkflowOperation(
  "problems.getMaintenanceCounts",
  (c: ProblemsWorkflowContext) => findMaintenanceCounts(c.db),
);
export const dryRunReparseWorkflow = defineWorkflowOperation(
  "problems.dryRunReparse",
  (c: ProblemsWorkflowContext) => dryRunReparse(c.db),
);
export const dryRunPruneAliasesWorkflow = defineWorkflowOperation(
  "problems.dryRunPruneAliases",
  (c: ProblemsWorkflowContext) => dryRunPruneAliases(c.db),
);
export const recipeUsageByProductWorkflow = defineWorkflowOperation(
  "problems.recipeUsageByProduct",
  (
    c: ProblemsWorkflowContext,
    input: z.output<typeof recipeUsageByProductInput>,
  ) => recipeUsageCountsByProduct(c.db, input.productShortcodes),
);
type DeleteUnusedIngredientsInput = z.output<
  typeof deleteUnusedIngredientsInput
>;
export const deleteUnusedIngredientsWorkflow = bindWorkflow(
  workflow<ProblemsWorkflowContext, DeleteUnusedIngredientsInput>(
    "problems.deleteUnused",
  )
    .call("shortcodes", async ({ context }, { input }) =>
      input.ingredientIds
        ? input.ingredientIds.map((id) => parseShortcodeFor("ingredient", id))
        : input.allFromProblem
          ? (await findAllViewProblemIds(context.db, input.allFromProblem)).map(
              (id) => parseShortcodeFor("ingredient", id),
            )
          : [],
    )
    .call("entityIds", async ({ context }, { shortcodes }) =>
      resolveAllOrThrow(context.db, "ingredient", shortcodes),
    )
    .commit("deleted", async ({ context }, { input, entityIds }) =>
      deleteUnusedIngredients(
        context.db,
        entityIds,
        input.alsoDeleteProducts,
        context.actorContext,
      ),
    )
    .call("presented", async (_, { shortcodes, entityIds, deleted }) => {
      const shortcodeByEntityId = new Map(
        shortcodes.map((shortcode, index) => [entityIds[index], shortcode]),
      );
      return {
        deleted: deleted.deleted,
        failed: deleted.failed.map(({ id, reason }) => {
          const shortcode = shortcodeByEntityId.get(id);
          if (!shortcode) {
            throw new Error(
              `Deleted ingredient result returned unknown id ${id}.`,
            );
          }
          return { id: shortcode, reason };
        }),
      };
    })
    .output(({ presented }) => presented),
);

export const resolveImportFindingWorkflow = defineWorkflowOperation(
  "problems.resolveImportFinding",
  (
    c: ProblemsWorkflowContext,
    input: z.output<typeof resolveImportFindingInput>,
  ) => resolveImportFinding(c.db, input, c.actorContext),
);

export const resolveArrivedFindingsWorkflow = defineWorkflowOperation(
  "problems.resolveArrivedFindings",
  async (
    c: ProblemsWorkflowContext,
    input: z.output<typeof resolveArrivedFindingsInput>,
  ) =>
    resolveArrivedFindingsForPurchase(
      c.db,
      { purchaseId: await resolveOrThrow(c.db, "purchase", input.purchaseId) },
      c.actorContext,
    ),
);

const reparseStaleDefinition = defineCoordinatorStream({
  name: "problems.reparseStale",
  select: workflow<ProblemsWorkflowContext, undefined>(
    "problems.reparseStale.items",
  )
    .call("selected", async ({ context }) =>
      selectStaleIngredientParses(context.db),
    )
    .output(({ selected }) => selected),
  commit: workflow<
    ProblemsWorkflowContext,
    {
      input: undefined;
      selection: Awaited<ReturnType<typeof selectStaleIngredientParses>>;
    }
  >("problems.reparseStale.commit")
    .commit("updated", async ({ context }, { input: { selection } }) =>
      reparseStaleIngredientParsesBatch(context.db, selection),
    )
    .effect("recipes", async ({ context }, { updated }) => {
      await context.services.recipeCosting.dispatchRecompute(
        updated.recipesAffected,
        { source: "problems.reparseStale" },
      );
      return updated;
    })
    .output(({ recipes }) => ({
      updated: recipes.updated,
      recipesAffected: recipes.recipesAffected.length,
    })),
  total: (selection) => selection.length,
});
export const reparseStaleWorkflow = bindCoordinatorStream(
  reparseStaleDefinition,
  (
    context: ProblemsWorkflowContext,
    _input: undefined = undefined,
    signal: AbortSignal = new AbortController().signal,
  ) => ({
    context,
    input: undefined,
    signal,
  }),
);

const pruneAllUnusedAliasesDefinition = defineCoordinatorStream({
  name: "problems.pruneAllUnusedAliases",
  select: workflow<ProblemsWorkflowContext, undefined>(
    "problems.pruneAllUnusedAliases.items",
  )
    .call("selected", async ({ context }) =>
      selectIngredientsWithUnusedAliases(context.db),
    )
    .output(({ selected }) => selected),
  commit: workflow<
    ProblemsWorkflowContext,
    {
      input: undefined;
      selection: Awaited<ReturnType<typeof selectIngredientsWithUnusedAliases>>;
    }
  >("problems.pruneAllUnusedAliases.commit")
    .commit("pruned", async ({ context }, { input: { selection } }) =>
      pruneUnusedIngredientAliasesBatch(context.db, selection),
    )
    .output(({ pruned }) => pruned),
  total: (selection) => selection.length,
});
export const pruneAllUnusedAliasesWorkflow = bindCoordinatorStream(
  pruneAllUnusedAliasesDefinition,
  (
    context: ProblemsWorkflowContext,
    _input: undefined = undefined,
    signal: AbortSignal = new AbortController().signal,
  ) => ({
    context,
    input: undefined,
    signal,
  }),
);
