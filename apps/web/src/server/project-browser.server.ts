import { projectContract } from "~/contracts/project.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";
import {
  projectCreateFromTasksWorkflow,
  projectDashboardSummaryWorkflow,
  projectDependencyGraphWorkflow,
  projectPortfolioAnalyticsWorkflow,
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
  createFromTasks: (context, input) =>
    projectCreateFromTasksWorkflow(context.db, input, context.actorContext),
  toolSuggestions: (context, input) =>
    projectToolSuggestionsWorkflow(context.db, input),
  toolMatrix: (context, input) => projectToolMatrixWorkflow(context.db, input),
  toolGallery: (context, input) =>
    projectToolGalleryWorkflow(context.db, input),
  setToolUsage: (context, input) =>
    projectSetToolUsageWorkflow(context.db, input, context.actorContext),
});
