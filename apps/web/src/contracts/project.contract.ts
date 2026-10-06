import { projectShortcode } from "@cubby/schemas/identifiers";
import * as schemas from "@cubby/schemas/project";
import { z } from "zod";

import { defineContract, mutation, query } from "~/contracts/define";

// House-status projections trim the dashboard payload the way the slim
// projections trim list rows: the output parse drops the keys below (zod
// objects strip unknown keys), so a new field on the underlying schema flows
// through without an MCP-side edit.

/** Project row minus the notes, id arrays and timestamps an entity get returns in full. */
const houseStatusProject = schemas.projectOut.omit({
  notes: true,
  googleDriveFolderUrl: true,
  notionPageUrl: true,
  childProjectIds: true,
  blockedByIds: true,
  blockingIds: true,
  createdAt: true,
  updatedAt: true,
});

/** Enough to name and schedule an upcoming task; the blocking graph lives elsewhere. */
const houseStatusTask = schemas.taskOut.pick({
  id: true,
  name: true,
  status: true,
  projectId: true,
  projectName: true,
  subjectProductId: true,
  subjectProductName: true,
  dueDate: true,
  dueEndDate: true,
  trade: true,
});

/** `dashboardSummary` minus `filterOptions` (UI select options only). */
const projectHouseStatusOut = schemas.projectDashboardSummaryOut
  .omit({
    filterOptions: true,
    projects: true,
    taskStatusByProject: true,
    nextTasks: true,
    attention: true,
  })
  .extend({
    projects: z.array(houseStatusProject),
    taskStatusByProject: z.array(schemas.projectTaskStatusBreakdown),
    nextTasks: z.array(houseStatusTask),
    attention: z.array(schemas.projectAttentionItemSchema),
  });

/** One project's planned-vs-actual envelope from `portfolioAnalytics.costVsEstimate` (subtree totals). */
const projectBudgetRow = z.object({
  projectId: projectShortcode,
  projectName: z.string(),
  estimate: z
    .number()
    .nullable()
    .describe("Budget envelope in dollars (subtree sum); null when unbudgeted"),
  actual: z.number().describe("Money already spent (subtree)"),
  committed: z.number().describe("Planned, not-yet-spent expenses (subtree)"),
  projected: z.number().describe("actual + committed"),
  remaining: z
    .number()
    .nullable()
    .describe("estimate − projected; null when there's no estimate"),
  percentUsed: z
    .number()
    .nullable()
    .describe("Whole-percent projected/estimate; null without an estimate"),
  overBudget: z.boolean().describe("projected exceeds estimate"),
});

const projectBudgetOut = z.object({
  projects: z
    .array(projectBudgetRow)
    .describe("Worst overrun first; unbudgeted projects last"),
  totals: z.object({
    estimate: z.number(),
    actual: z.number(),
    committed: z.number(),
    projected: z.number(),
    overBudgetCount: z.number().int(),
    missingEstimateCount: z.number().int(),
  }),
  plannedVsActualByMonth:
    schemas.projectPortfolioAnalyticsOut.shape.plannedVsActual,
});

export const projectContract = defineContract("project", {
  dashboardSummary: query({
    mcp: { omit: "agent_twin", twin: "project.houseStatus" },
    native: "Project analytics summary",
    input: schemas.projectDashboardFiltersSchema,
    output: schemas.projectDashboardSummaryOut,
    cache: { profile: "stable" },
  }),
  tree: query({
    mcp: { omit: "client_view" },
    input: schemas.projectTreeInput,
    output: schemas.projectTreeOut,
  }),
  getDependencyGraph: query({
    mcp: { omit: "client_view" },
    input: schemas.projectDependencyGraphInput,
    output: schemas.projectDependencyGraphSchema,
    cache: { tags: [["project", "dependencyGraph"]] },
  }),
  portfolioAnalytics: query({
    mcp: {
      omit: "client_view",
      note: "Project analytics charts; agents read budgets through project_overview.budget and spend through project_overview.expense_analytics",
    },
    native: "Project analytics",
    input: schemas.projectDashboardFiltersSchema,
    output: schemas.projectPortfolioAnalyticsOut,
    cache: { profile: "stable" },
  }),
  createFromTasks: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["create", "bulkUpdate"],
      note: "entity.create a project, then entity.bulkUpdate its tasks",
    },
    input: schemas.createProjectFromTasksInput,
    output: schemas.createProjectFromTasksOut,
    invalidates: ["taskProject"],
  }),
  toolSuggestions: query({
    input: schemas.projectResourceProjectInput,
    output: schemas.projectToolSuggestionsOut,
    cache: {
      tags: [
        ["project", "toolSuggestions"],
        ["project", "resource"],
      ],
    },
  }),
  toolMatrix: query({
    mcp: { omit: "client_view" },
    input: schemas.projectToolMatrixInput,
    output: schemas.projectToolMatrixOut,
    cache: {
      tags: [
        ["project", "toolMatrix"],
        ["project", "resource"],
      ],
    },
  }),
  toolGallery: query({
    mcp: { omit: "client_view" },
    input: schemas.toolGalleryInput,
    output: schemas.toolGalleryOut,
    cache: {
      tags: [
        ["project", "toolGallery"],
        ["product", "toolGallery"],
        ["inventory", "toolGallery"],
        ["location", "toolGallery"],
        ["image", "toolGallery"],
        ["expense", "toolGallery"],
      ],
    },
  }),
  setToolUsage: mutation({
    mcp: {
      omit: "kernel_alternative",
      kernel: ["link", "unlink"],
      note: "entity.link and entity.unlink on project resources",
    },
    input: schemas.projectToolUsageSetInput,
    output: schemas.projectToolUsageSetOut,
    invalidates: ["projectResource"],
  }),
  // Agent-facing (MCP `project_overview`, `entity`): off the HTTP API.
  /** The dashboard summary scoped to live statuses unless a scope is given. */
  houseStatus: query({
    http: false,
    input: schemas.projectDashboardFiltersSchema,
    output: projectHouseStatusOut,
  }),
  /** Subtree budget vs actual + committed, worst overrun first. */
  budget: query({
    http: false,
    input: schemas.projectDashboardFiltersSchema,
    output: projectBudgetOut,
  }),
  /** Move a Product's recorded project uses onto another Product. */
  repointUses: mutation({
    http: false,
    input: schemas.repointProjectUsesInput,
    output: schemas.repointProjectUsesOut,
    invalidates: ["projectResource"],
  }),
});
