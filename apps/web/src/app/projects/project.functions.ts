import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

import { ripple } from "~/integrations/tanstack-query/cache-tags";
import {
  defineOperationDomain,
  mutation,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const project = defineOperationDomain("project", {
  dashboardSummary: query({
    input: schemas.projectDashboardFiltersSchema,
    output: schemas.projectDashboardSummaryOut,
    tags: [["project", "dashboardSummary"]],
    cache: "stable",
  }),
  tree: query({
    input: schemas.projectTreeInput,
    output: schemas.projectTreeOut,
    tags: [["project", "tree"]],
  }),
  portfolioAnalytics: query({
    input: schemas.projectDashboardFiltersSchema,
    output: schemas.projectPortfolioAnalyticsOut,
    tags: [["project", "portfolioAnalytics"]],
    cache: "stable",
  }),
  options: query({
    input: z.undefined(),
    output: z.array(schemas.projectOptionsOut),
    tags: [["project", "options"]],
  }),
  createFromTasks: mutation({
    input: schemas.createProjectFromTasksInput,
    output: schemas.createProjectFromTasksOut,
    invalidates: ripple.taskProject,
  }),
  resources: query({
    input: schemas.projectResourceProjectInput,
    output: schemas.projectResourcesOut,
    tags: [
      ["project", "resources"],
      ["project", "resource"],
    ],
  }),
  toolSuggestions: query({
    input: schemas.projectResourceProjectInput,
    output: schemas.projectToolSuggestionsOut,
    tags: [
      ["project", "toolSuggestions"],
      ["project", "resource"],
    ],
  }),
  attachResources: mutation({
    input: schemas.projectResourceMutationInput,
    output: schemas.projectResourceMutationOut,
    invalidates: ripple.projectResource,
  }),
  detachResources: mutation({
    input: schemas.projectResourceMutationInput,
    output: schemas.projectResourceMutationOut,
    invalidates: ripple.projectResource,
  }),
  toolMatrix: query({
    input: schemas.projectToolMatrixInput,
    output: schemas.projectToolMatrixOut,
    tags: [
      ["project", "toolMatrix"],
      ["project", "resource"],
    ],
  }),
  toolGallery: query({
    input: schemas.toolGalleryInput,
    output: schemas.toolGalleryOut,
    tags: [
      ["project", "toolGallery"],
      ["product", "toolGallery"],
      ["inventory", "toolGallery"],
      ["location", "toolGallery"],
      ["image", "toolGallery"],
      ["expense", "toolGallery"],
    ],
  }),
  setToolUsage: mutation({
    input: schemas.projectToolUsageSetInput,
    output: schemas.projectToolUsageSetOut,
    invalidates: ripple.projectResource,
  }),
});
