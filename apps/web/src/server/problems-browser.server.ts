import { referentialLivenessViolationSchema } from "@cubby/schemas/entity-integrity";
import { z } from "zod";
import type { StartOperationResult } from "~/server/start-operation.contract";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  cleanupOrphanedEmbeddingsWorkflow,
  deleteUnusedIngredientsWorkflow,
  dryRunPruneAliasesWorkflow,
  dryRunReparseWorkflow,
  findCoverageProblemsWorkflow,
  findCoverageTotalsWorkflow,
  findFastProblemsWorkflow,
  findMaintenanceCountsWorkflow,
  findProblemByTypeWorkflow,
  findProblemCountsWorkflow,
  findTrackerProblemsWorkflow,
  findUpcProblemsWorkflow,
  findViewProblemsWorkflow,
  type ProblemsWorkflowContext,
  problemsWorkflowSchemas,
  recipeUsageByProductWorkflow,
} from "~/server/workflows/problems.server";

type SchemaPair = { input: z.ZodType; output: z.ZodType };
const run = <S extends SchemaPair>(o: {
  operation: string;
  type: "query" | "mutation";
  schemas: S;
  data: z.input<S["input"]>;
  request: StartOperationRequest;
  workflow: (
    context: ProblemsWorkflowContext,
    input: z.output<S["input"]>,
  ) => Promise<unknown>;
}): Promise<StartOperationResult<z.output<S["output"]>>> =>
  runStartOperation<S["input"], z.output<S["output"]>>({
    operation: o.operation,
    type: o.type,
    input: o.data,
    inputSchema: o.schemas.input,
    outputSchema: o.schemas.output as z.ZodType<z.output<S["output"]>>,
    request: o.request,
    readPolicy: o.type === "query" ? "strong" : undefined,
    run: (context, input) => o.workflow(context, input),
  });

const schemas = problemsWorkflowSchemas;
export const getFastProblemsForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "problems.getFast",
    type: "query",
    schemas: schemas.getFast,
    workflow: (c) => findFastProblemsWorkflow(c),
  });
export const getProblemCountsForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "problems.getCounts",
    type: "query",
    schemas: schemas.getCounts,
    workflow: (c) => findProblemCountsWorkflow(c),
  });
const referentialLivenessInput = z.object({
  key: z.literal("referentialLivenessViolations"),
});
const referentialLivenessOutput = z.object({
  type: z.literal("referentialLivenessViolations"),
  items: z.array(referentialLivenessViolationSchema),
  total: z.number().int().nonnegative(),
});
export const getProblemByType = (o: {
  data: z.input<typeof referentialLivenessInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "problems.getByType",
    type: "query",
    input: o.data,
    inputSchema: referentialLivenessInput,
    outputSchema: referentialLivenessOutput,
    request: o.request,
    readPolicy: "strong",
    run: (context, input) => findProblemByTypeWorkflow(context, input),
  });
export const getViewProblemsForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "problems.getViews",
    type: "query",
    schemas: schemas.getViews,
    workflow: (c) => findViewProblemsWorkflow(c),
  });
export const getCoverageProblemsForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "problems.getCoverage",
    type: "query",
    schemas: schemas.getCoverage,
    workflow: (c) => findCoverageProblemsWorkflow(c),
  });
export const getUpcProblemsForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "problems.getUpc",
    type: "query",
    schemas: schemas.getUpc,
    workflow: (c) => findUpcProblemsWorkflow(c),
  });
export const getTrackerProblemsForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "problems.getTracker",
    type: "query",
    schemas: schemas.getTracker,
    workflow: (c) => findTrackerProblemsWorkflow(c),
  });
export const getCoverageTotalsForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "problems.getCoverageTotals",
    type: "query",
    schemas: schemas.getCoverageTotals,
    workflow: (c) => findCoverageTotalsWorkflow(c),
  });
export const getMaintenanceCountsForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "problems.getMaintenanceCounts",
    type: "query",
    schemas: schemas.getMaintenanceCounts,
    workflow: (c) => findMaintenanceCountsWorkflow(c),
  });
export const dryRunReparseForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "problems.dryRunReparse",
    type: "query",
    schemas: schemas.dryRunReparse,
    workflow: (c) => dryRunReparseWorkflow(c),
  });
export const dryRunPruneAliasesForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    data: undefined,
    operation: "problems.dryRunPruneAliases",
    type: "query",
    schemas: schemas.dryRunPruneAliases,
    workflow: (c) => dryRunPruneAliasesWorkflow(c),
  });
export const getRecipeUsageByProductForBrowser = (o: {
  data: z.input<typeof schemas.recipeUsageByProduct.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "problems.recipeUsageByProduct",
    type: "query",
    schemas: schemas.recipeUsageByProduct,
    workflow: recipeUsageByProductWorkflow,
  });
export const deleteUnusedIngredientsForBrowser = (o: {
  data: z.input<typeof schemas.deleteUnused.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "problems.deleteUnused",
    type: "mutation",
    schemas: schemas.deleteUnused,
    workflow: deleteUnusedIngredientsWorkflow,
  });
export const cleanupOrphanedEmbeddingsForBrowser = (o: {
  data: z.input<typeof schemas.cleanupOrphanedEmbeddings.input>;
  request: StartOperationRequest;
}) =>
  run({
    ...o,
    operation: "problems.cleanupOrphanedEmbeddings",
    type: "mutation",
    schemas: schemas.cleanupOrphanedEmbeddings,
    workflow: cleanupOrphanedEmbeddingsWorkflow,
  });
