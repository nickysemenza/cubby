import * as schemas from "@cubby/schemas/project";
import { z } from "zod";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const project = defineOperationDomain("project", {
  dashboardSummary: query({
    input: schemas.projectDashboardFiltersSchema,
    output: schemas.projectDashboardSummaryOut,
    tags: [["project"], ["project", "dashboardSummary"]],
  }),
  tree: query({
    input: schemas.projectTreeInput,
    output: schemas.projectTreeOut,
    tags: [["project"], ["project", "tree"]],
  }),
  portfolioAnalytics: query({
    input: schemas.projectDashboardFiltersSchema,
    output: schemas.projectPortfolioAnalyticsOut,
    tags: [["project"], ["project", "portfolioAnalytics"]],
  }),
  options: query({
    input: z.undefined(),
    output: z.array(schemas.projectOptionsOut),
    tags: [["project"], ["project", "options"]],
  }),
  createFromTasks: mutation({
    input: schemas.createProjectFromTasksInput,
    output: schemas.createProjectFromTasksOut,
    invalidates: [["task"], ["project"]],
  }),
  resources: query({
    input: schemas.projectResourceProjectInput,
    output: schemas.projectResourcesOut,
    tags: [["project"], ["project", "resources"], ["project", "resource"]],
  }),
  toolSuggestions: query({
    input: schemas.projectResourceProjectInput,
    output: schemas.projectToolSuggestionsOut,
    tags: [
      ["project"],
      ["project", "toolSuggestions"],
      ["project", "resource"],
    ],
  }),
  attachResources: mutation({
    input: schemas.projectResourceMutationInput,
    output: schemas.projectResourceMutationOut,
    invalidates: [["project", "resource"]],
  }),
  detachResources: mutation({
    input: schemas.projectResourceMutationInput,
    output: schemas.projectResourceMutationOut,
    invalidates: [["project", "resource"]],
  }),
  toolMatrix: query({
    input: schemas.projectToolMatrixInput,
    output: schemas.projectToolMatrixOut,
    tags: [["project"], ["project", "toolMatrix"], ["project", "resource"]],
  }),
  setToolUsage: mutation({
    input: schemas.projectToolUsageSetInput,
    output: schemas.projectToolUsageSetOut,
    invalidates: [["project", "resource"]],
  }),
});
