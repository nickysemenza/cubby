import { projectContract } from "~/contracts/project.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  projectAttachResourcesWorkflow,
  projectCreateFromTasksWorkflow,
  projectDashboardSummaryWorkflow,
  projectDependencyGraphWorkflow,
  projectDetachResourcesWorkflow,
  projectOptionsWorkflow,
  projectPortfolioAnalyticsWorkflow,
  projectResourcesWorkflow,
  projectSetToolUsageWorkflow,
  projectToolMatrixWorkflow,
  projectToolGalleryWorkflow,
  projectToolSuggestionsWorkflow,
  projectTreeWorkflow,
} from "~/server/workflows/project.server";

export const projectHandlers = implementOperationDomain(projectContract, {
  getDependencyGraph: (context, input) =>
    projectDependencyGraphWorkflow(context.db, input),
  tree: (context, input) => projectTreeWorkflow(context.db, input),
  dashboardSummary: (context, input) =>
    projectDashboardSummaryWorkflow(context.db, input),
  portfolioAnalytics: (context, input) =>
    projectPortfolioAnalyticsWorkflow(context.db, input),
  options: (context) => projectOptionsWorkflow(context.db),
  createFromTasks: (context, input) =>
    projectCreateFromTasksWorkflow(context.db, input, context.actorContext),
  resources: (context, input) => projectResourcesWorkflow(context.db, input),
  toolSuggestions: (context, input) =>
    projectToolSuggestionsWorkflow(context.db, input),
  attachResources: (context, input) =>
    projectAttachResourcesWorkflow(context.db, input, context.actorContext),
  detachResources: (context, input) =>
    projectDetachResourcesWorkflow(context.db, input, context.actorContext),
  toolMatrix: (context, input) => projectToolMatrixWorkflow(context.db, input),
  toolGallery: (context, input) =>
    projectToolGalleryWorkflow(context.db, input),
  setToolUsage: (context, input) =>
    projectSetToolUsageWorkflow(context.db, input, context.actorContext),
});
