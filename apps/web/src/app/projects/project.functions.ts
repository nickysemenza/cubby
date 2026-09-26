import { projectContract } from "~/contracts/project.contract";
import { ripple } from "~/integrations/tanstack-query/cache-tags";
import { defineOperationDomain } from "~/integrations/tanstack-query/operation-catalog";

export const project = defineOperationDomain(projectContract, {
  dashboardSummary: {
    tags: [["project", "dashboardSummary"]],
    cache: "stable",
  },
  tree: { tags: [["project", "tree"]] },
  getDependencyGraph: { tags: [["project", "dependencyGraph"]] },
  portfolioAnalytics: {
    tags: [["project", "portfolioAnalytics"]],
    cache: "stable",
  },
  createFromTasks: { invalidates: ripple.taskProject },
  toolSuggestions: {
    tags: [
      ["project", "toolSuggestions"],
      ["project", "resource"],
    ],
  },
  toolMatrix: {
    tags: [
      ["project", "toolMatrix"],
      ["project", "resource"],
    ],
  },
  toolGallery: {
    tags: [
      ["project", "toolGallery"],
      ["product", "toolGallery"],
      ["inventory", "toolGallery"],
      ["location", "toolGallery"],
      ["image", "toolGallery"],
      ["expense", "toolGallery"],
    ],
  },
  setToolUsage: { invalidates: ripple.projectResource },
});
