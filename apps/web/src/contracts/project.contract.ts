import { projectShortcode } from "@cubby/schemas/identifiers";
import { projectResourceFeatureLabels } from "@cubby/schemas/product-category-relations";
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
  due: true,
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

export const projectContract = defineContract(
  "project",
  {
    dashboardSummary: query({
      native: "Project analytics summary",
      nativeModels: { output: "json" },
      input: schemas.projectDashboardFiltersSchema,
      output: schemas.projectDashboardSummaryOut,
      cache: { profile: "stable" },
    }),
    tree: query({
      input: schemas.projectTreeInput,
      output: schemas.projectTreeOut,
    }),
    getDependencyGraph: query({
      input: schemas.projectDependencyGraphInput,
      output: schemas.projectDependencyGraphSchema,
      cache: { tags: [["project", "dependencyGraph"]] },
    }),
    createFromTasks: mutation({
      note: "entity.create a project, then entity.bulkUpdate its tasks",
      command: { label: "Create project from tasks", confirmation: null },
      input: schemas.createProjectFromTasksInput,
      output: schemas.createProjectFromTasksOut,
      invalidates: ["taskProject"],
    }),
    toolSuggestions: query({
      exposure: "capability",
      description:
        "Inventoried Cubby tools to link to one exact project: tools purchased for the project at $100+ and trade-matched tools whose purchase history supports the project's task/expense trades; cheaper trade matches need at least two explicit prior project uses. A review queue only — it never links tools automatically.",
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
      note: "entity.link and entity.unlink on project resources",
      command: { label: "Set tool usage", confirmation: null },
      input: schemas.projectToolUsageSetInput,
      output: schemas.projectToolUsageSetOut,
      invalidates: ["projectResource"],
    }),
    // Agent-facing (MCP `project_overview`, `entity`).
    /** The dashboard summary scoped to live statuses unless a scope is given. */
    houseStatus: query({
      exposure: "capability",
      description:
        'What needs attention around the house, in one call: portfolio counts (active projects, open tasks, actual vs committed spend), the active projects with own + subtree rollups, a per-project task-status breakdown, the next upcoming tasks, and `attention[]` — overdue tasks, stalled projects, past-due planned expenses, missing budgets, unclassified expenses and blocked work, each with a severity, the entity it points at, and a link. Start here for "how are the projects going" / "what should I deal with", then drill in with entity_read.get(project) or list(task). Optional filters scope it to a status set, project kinds, locations, a search term, or a date window (dateFrom/dateTo — a project matches when its startDate/endDate override overlaps the window OR it has a task or expense of its own inside it; only projects with no override and no dated content are dropped, counted in hiddenByDate.projects). statusScope defaults to the live statuses (planning/not_started/in_progress) so this payload does not balloon with completed history — pass statusScope explicitly (e.g. ["done"]) to include finished projects.',
      input: schemas.projectDashboardFiltersSchema,
      output: projectHouseStatusOut,
    }),
    /** Subtree budget vs actual + committed, worst overrun first. */
    budget: query({
      exposure: "capability",
      description:
        "Which projects are over budget: per project, the subtree budget estimate vs actual + committed spend, with remaining, percentUsed and an overBudget flag, worst overrun first (unbudgeted projects last), plus portfolio totals and planned-vs-actual spend by month. Same optional scope filters as house_status, but statusScope defaults to no condition (all four statuses, including done) — a budget read silently omitting completed spend would be a bug. dateFrom/dateTo scope the whole query, not just the monthly series: while a window is set a project is kept when its startDate/endDate override overlaps it OR it owns a task or expense inside it.",
      input: schemas.projectDashboardFiltersSchema,
      output: projectBudgetOut,
    }),
    /** Move a Product's recorded project uses onto another Product. */
    repointUses: mutation({
      exposure: "capability",
      description: `Move a Product's recorded project uses onto another Product, in one transaction — how to retire or split a Product that entity.delete refuses because it has project-use history: repoint the history onto the component or replacement that should carry it, then delete. Do NOT do this as entity.unlink plus entity.link — an unlink whose link is missed discards the project's tool history with nothing to flag it. Omit projectIds to move every live use. Projects that already record the destination keep their existing row and are reported as alreadyPresent, not as an error. The destination must be a live Product in a category that allows project resources (${projectResourceFeatureLabels}).`,
      input: schemas.repointProjectUsesInput,
      output: schemas.repointProjectUsesOut,
      invalidates: ["projectResource"],
    }),
  },
  { exposure: "view", mcpToolGroup: "project_overview" },
);
