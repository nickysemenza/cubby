import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

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
  options: query({
    input: z.undefined(),
    output: z.array(schemas.projectOptionsOut),
  }),
  createFromTasks: mutation({
    input: schemas.createProjectFromTasksInput,
    output: schemas.createProjectFromTasksOut,
  }),
  resources: query({
    input: schemas.projectResourceProjectInput,
    output: schemas.projectResourcesOut,
  }),
  toolSuggestions: query({
    input: schemas.projectResourceProjectInput,
    output: schemas.projectToolSuggestionsOut,
  }),
  attachResources: mutation({
    input: schemas.projectResourceMutationInput,
    output: schemas.projectResourceMutationOut,
  }),
  detachResources: mutation({
    input: schemas.projectResourceMutationInput,
    output: schemas.projectResourceMutationOut,
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
