import * as schemas from "@cubby/schemas/project";

import { defineContract, mutation, query } from "~/contracts/define";

export const projectContract = defineContract("project", {
  dashboardSummary: query({
    native: "Project analytics summary",
    input: schemas.projectDashboardFiltersSchema,
    output: schemas.projectDashboardSummaryOut,
  }),
  tree: query({
    input: schemas.projectTreeInput,
    output: schemas.projectTreeOut,
  }),
  getDependencyGraph: query({
    input: schemas.projectDependencyGraphInput,
    output: schemas.projectDependencyGraphSchema,
  }),
  portfolioAnalytics: query({
    native: "Project analytics",
    input: schemas.projectDashboardFiltersSchema,
    output: schemas.projectPortfolioAnalyticsOut,
  }),
  createFromTasks: mutation({
    input: schemas.createProjectFromTasksInput,
    output: schemas.createProjectFromTasksOut,
  }),
  toolSuggestions: query({
    mcp: {
      name: "suggest_project_tools",
      description:
        "Suggest inventoried Cubby tools to attach to one exact project. Suggestions include tools purchased for the project at $100+ and trade-matched tools whose purchase history supports the project's task/expense trades; cheaper trade matches require at least two explicit prior project uses. This is a review queue only and never attaches tools automatically.",
    },
    input: schemas.projectResourceProjectInput,
    output: schemas.projectToolSuggestionsOut,
  }),
  toolMatrix: query({
    input: schemas.projectToolMatrixInput,
    output: schemas.projectToolMatrixOut,
  }),
  toolGallery: query({
    input: schemas.toolGalleryInput,
    output: schemas.toolGalleryOut,
  }),
  setToolUsage: mutation({
    input: schemas.projectToolUsageSetInput,
    output: schemas.projectToolUsageSetOut,
  }),
});
