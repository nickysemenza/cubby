import { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";
import {
  createProjectFromTasksInput,
  createProjectFromTasksOut,
  projectAttachResourcesWorkflow,
  projectCreateFromTasksWorkflow,
  projectDashboardFiltersSchema,
  projectDashboardSummaryOut,
  projectDashboardSummaryWorkflow,
  projectDetachResourcesWorkflow,
  projectOptionsOut,
  projectOptionsWorkflow,
  projectPortfolioAnalyticsOut,
  projectPortfolioAnalyticsWorkflow,
  projectResourceMutationInput,
  projectResourceMutationOut,
  projectResourceProjectInput,
  projectResourcesOut,
  projectResourcesWorkflow,
  projectSetToolUsageWorkflow,
  projectToolMatrixInput,
  projectToolMatrixOut,
  projectToolMatrixWorkflow,
  projectToolSuggestionsOut,
  projectToolSuggestionsWorkflow,
  projectToolUsageSetInput,
  projectToolUsageSetOut,
  projectTreeInput,
  projectTreeOut,
  projectTreeWorkflow,
} from "~/server/workflows/project.server";

export const getProjectTreeForBrowser = (o: {
  data: z.input<typeof projectTreeInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.tree",
    type: "query",
    input: o.data,
    inputSchema: projectTreeInput,
    outputSchema: projectTreeOut,
    request: o.request,
    run: (c, input) => projectTreeWorkflow(c.db, input),
  });

export const getProjectDashboardSummaryForBrowser = (o: {
  data: z.input<typeof projectDashboardFiltersSchema>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.dashboardSummary",
    type: "query",
    input: o.data,
    inputSchema: projectDashboardFiltersSchema,
    outputSchema: projectDashboardSummaryOut,
    request: o.request,
    run: (c, input) => projectDashboardSummaryWorkflow(c.db, input),
  });
export const getProjectPortfolioAnalyticsForBrowser = (o: {
  data: z.input<typeof projectDashboardFiltersSchema>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.portfolioAnalytics",
    type: "query",
    input: o.data,
    inputSchema: projectDashboardFiltersSchema,
    outputSchema: projectPortfolioAnalyticsOut,
    request: o.request,
    run: (c, input) => projectPortfolioAnalyticsWorkflow(c.db, input),
  });
export const getProjectOptionsForBrowser = (o: {
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.options",
    type: "query",
    input: undefined,
    inputSchema: z.undefined(),
    outputSchema: z.array(projectOptionsOut),
    request: o.request,
    run: (c) => projectOptionsWorkflow(c.db),
  });
export const createProjectFromTasksForBrowser = (o: {
  data: z.input<typeof createProjectFromTasksInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.createFromTasks",
    type: "mutation",
    input: o.data,
    inputSchema: createProjectFromTasksInput,
    outputSchema: createProjectFromTasksOut,
    request: o.request,
    run: (c, input) =>
      projectCreateFromTasksWorkflow(c.db, input, c.actorContext),
  });
export const listProjectResourcesForBrowser = (o: {
  data: z.input<typeof projectResourceProjectInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.resources",
    type: "query",
    input: o.data,
    inputSchema: projectResourceProjectInput,
    outputSchema: projectResourcesOut,
    request: o.request,
    run: (c, input) => projectResourcesWorkflow(c.db, input),
  });
export const suggestProjectToolsForBrowser = (o: {
  data: z.input<typeof projectResourceProjectInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.toolSuggestions",
    type: "query",
    input: o.data,
    inputSchema: projectResourceProjectInput,
    outputSchema: projectToolSuggestionsOut,
    request: o.request,
    run: (c, input) => projectToolSuggestionsWorkflow(c.db, input),
  });
export const attachProjectResourcesForBrowser = (o: {
  data: z.input<typeof projectResourceMutationInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.attachResources",
    type: "mutation",
    input: o.data,
    inputSchema: projectResourceMutationInput,
    outputSchema: projectResourceMutationOut,
    request: o.request,
    run: (c, input) =>
      projectAttachResourcesWorkflow(c.db, input, c.actorContext),
  });
export const detachProjectResourcesForBrowser = (o: {
  data: z.input<typeof projectResourceMutationInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.detachResources",
    type: "mutation",
    input: o.data,
    inputSchema: projectResourceMutationInput,
    outputSchema: projectResourceMutationOut,
    request: o.request,
    run: (c, input) =>
      projectDetachResourcesWorkflow(c.db, input, c.actorContext),
  });
export const projectToolMatrixForBrowser = (o: {
  data: z.input<typeof projectToolMatrixInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.toolMatrix",
    type: "query",
    input: o.data,
    inputSchema: projectToolMatrixInput,
    outputSchema: projectToolMatrixOut,
    request: o.request,
    run: (c, input) => projectToolMatrixWorkflow(c.db, input),
  });
export const setProjectToolUsageForBrowser = (o: {
  data: z.input<typeof projectToolUsageSetInput>;
  request: StartOperationRequest;
}) =>
  runStartOperation({
    operation: "project.setToolUsage",
    type: "mutation",
    input: o.data,
    inputSchema: projectToolUsageSetInput,
    outputSchema: projectToolUsageSetOut,
    request: o.request,
    run: (c, input) => projectSetToolUsageWorkflow(c.db, input, c.actorContext),
  });
