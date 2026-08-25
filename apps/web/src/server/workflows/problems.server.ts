import type { IngredientShortcode } from "@cubby/schemas/identifiers";
import {
  cleanupOrphanedEntityEmbeddingsInput,
  cleanupOrphanedEntityEmbeddingsOut,
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
} from "@cubby/schemas/problems";
import { z } from "zod";
import { expectedProblemKeys } from "~/entities/problem-registry";
import { getProblemCountsCache } from "~/server/cf-env";
import { recipeUsageCountsByProduct } from "~/server/repo/problems";
import { resolveAllOrThrow } from "~/server/repo/shortcode-resolver";
import { getCachedProblemCounts } from "~/server/services/problem-counts-cache";
import {
  findAllViewProblemIds,
  findViewProblems,
} from "~/server/services/problem-views.service";
import {
  cleanupOrphanedEntityEmbeddings,
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
  pruneAllUnusedAliases,
  reparseStaleIngredientParses,
} from "~/server/services/problems.service";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";

export type ProblemsWorkflowContext = Pick<
  AuthenticatedStartOperationContext,
  "db" | "upcLookupClient" | "usdaClient" | "actorContext" | "services"
>;

const problemKeySchema = z.enum(
  expectedProblemKeys as [
    (typeof expectedProblemKeys)[number],
    ...(typeof expectedProblemKeys)[number][],
  ],
);
const problemByTypeSchema = z.object({
  type: problemKeySchema,
  items: z.array(z.unknown()),
  total: z.number().int().nonnegative(),
});
const noInput = z.undefined();
export const problemsWorkflowSchemas = {
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
  cleanupOrphanedEmbeddings: {
    input: cleanupOrphanedEntityEmbeddingsInput,
    output: cleanupOrphanedEntityEmbeddingsOut,
  },
} as const;

export const findFastProblemsWorkflow = (c: ProblemsWorkflowContext) =>
  findFastProblems(c.db);
export const findProblemCountsWorkflow = (c: ProblemsWorkflowContext) =>
  getCachedProblemCounts(c.db, c.upcLookupClient, getProblemCountsCache());
export const findProblemByTypeWorkflow = (
  c: ProblemsWorkflowContext,
  input: z.output<typeof problemsWorkflowSchemas.getByType.input>,
) => findProblemByType(c.db, input.key, c.upcLookupClient, c.usdaClient);
export const findViewProblemsWorkflow = (c: ProblemsWorkflowContext) =>
  findViewProblems(c.db);
export const findCoverageProblemsWorkflow = (c: ProblemsWorkflowContext) =>
  findCoverageProblems(c.db, c.usdaClient);
export const findUpcProblemsWorkflow = (c: ProblemsWorkflowContext) =>
  findUpcProblems(c.db, c.upcLookupClient);
export const findTrackerProblemsWorkflow = (c: ProblemsWorkflowContext) =>
  findTrackerProblems(c.db);
export const findCoverageTotalsWorkflow = (c: ProblemsWorkflowContext) =>
  findCoverageTotals(c.db);
export const findMaintenanceCountsWorkflow = (c: ProblemsWorkflowContext) =>
  findMaintenanceCounts(c.db);
export const dryRunReparseWorkflow = (c: ProblemsWorkflowContext) =>
  dryRunReparse(c.db);
export const dryRunPruneAliasesWorkflow = (c: ProblemsWorkflowContext) =>
  dryRunPruneAliases(c.db);
export const recipeUsageByProductWorkflow = (
  c: ProblemsWorkflowContext,
  input: z.output<typeof recipeUsageByProductInput>,
) => recipeUsageCountsByProduct(c.db, input.productShortcodes);
export const cleanupOrphanedEmbeddingsWorkflow = (
  c: ProblemsWorkflowContext,
  input: z.output<typeof cleanupOrphanedEntityEmbeddingsInput>,
) => cleanupOrphanedEntityEmbeddings(c.db, input?.ids);
export const deleteUnusedIngredientsWorkflow = async (
  c: ProblemsWorkflowContext,
  input: z.output<typeof deleteUnusedIngredientsInput>,
) => {
  const shortcodes = (input.ingredientIds ??
    (input.allFromProblem
      ? await findAllViewProblemIds(c.db, input.allFromProblem)
      : [])) as IngredientShortcode[];
  const entityIds = await resolveAllOrThrow(c.db, "ingredient", shortcodes);
  const result = await deleteUnusedIngredients(
    c.db,
    entityIds,
    input.alsoDeleteProducts,
    c.actorContext,
  );
  const shortcodeByEntityId = new Map(
    shortcodes.map((shortcode, index) => [entityIds[index], shortcode]),
  );
  return {
    deleted: result.deleted,
    failed: result.failed.map(({ id, reason }) => ({
      id: shortcodeByEntityId.get(id)!,
      reason,
    })),
  };
};
export const reparseStaleWorkflow = async function* (
  c: ProblemsWorkflowContext,
) {
  const generator = reparseStaleIngredientParses(c.db);
  let next = await generator.next();
  while (!next.done) {
    yield {
      type: "progress" as const,
      done: next.value.done,
      total: next.value.total,
    };
    next = await generator.next();
  }
  await c.services.recipeCosting.dispatchRecompute(next.value.recipesAffected, {
    source: "problems.reparseStale",
  });
  yield {
    type: "done" as const,
    result: {
      updated: next.value.updated,
      recipesAffected: next.value.recipesAffected.length,
    },
  };
};
export const pruneAllUnusedAliasesWorkflow = async function* (
  c: ProblemsWorkflowContext,
) {
  const generator = pruneAllUnusedAliases(c.db);
  let next = await generator.next();
  while (!next.done) {
    yield {
      type: "progress" as const,
      done: next.value.done,
      total: next.value.total,
    };
    next = await generator.next();
  }
  yield { type: "done" as const, result: next.value };
};
