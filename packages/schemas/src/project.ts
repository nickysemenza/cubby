import { z } from "zod";
import { financialReconciliationSummary } from "./financial-reconciliation";
import { wholeCentAmount } from "./money";
import {
  expenseRelatedFilterFields,
  projectRelatedFilterFields,
  taskRelatedFilterFields,
} from "./related-view";
import { mutationSideEffectsSchema } from "./background-jobs";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
} from "./base-entity";
import type { ShortcodeEntity } from "./entity-manifest";
import {
  anyShortcodeSchema,
  expenseShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  taskShortcode,
  vendorShortcode,
} from "./identifiers";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";

/**
 * Home-project tracker schemas: `project` (a household undertaking), `task`
 * (a step inside one), and `expense` (a spend, usually attached to one).
 * Migrated from the retired Notion databases; option sets are carried over
 * verbatim (emoji stripped). Cost/progress rollups are SQL aggregates over
 * live expenses/tasks — never denormalized onto the project row.
 *
 * `locations` is deliberately a free-form string array (house names live in
 * the DB, not in committed code); filter options derive from the data.
 */

/** A calendar day as a plain "YYYY-MM-DD" string, timezone-free. */
export const plainDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .meta({ mockValue: "2024-01-15" })
  .describe('Calendar day as "YYYY-MM-DD"');

/**
 * Parse a complete provider URL without canonicalizing it. URL is used only
 * for validation; the original trimmed string is what the schema returns, so
 * pasted sharing query params/fragments survive unchanged.
 */
function isProviderUrl(value: string, matches: (url: URL) => boolean): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && matches(url);
  } catch {
    return false;
  }
}

const googleDriveFolderUrl = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .refine(
    (value) =>
      value === null ||
      isProviderUrl(
        value,
        (url) =>
          url.hostname === "drive.google.com" &&
          /^\/drive\/(?:u\/\d+\/)?folders\/[^/]+\/?$/.test(url.pathname),
      ),
    "Enter a valid Google Drive folder URL",
  )
  .describe(
    "Complete HTTPS drive.google.com folder URL; empty input clears the field",
  );

const notionPageUrl = z
  .string()
  .trim()
  .transform((value) => (value === "" ? null : value))
  .nullable()
  .refine(
    (value) =>
      value === null ||
      isProviderUrl(value, (url) => {
        const notionHost =
          url.hostname === "notion.so" ||
          url.hostname.endsWith(".notion.so") ||
          url.hostname === "notion.site" ||
          url.hostname.endsWith(".notion.site") ||
          url.hostname === "app.notion.com";
        return notionHost && url.pathname.split("/").some(Boolean);
      }),
    "Enter a valid Notion page URL",
  )
  .describe(
    "Complete HTTPS notion.so/notion.site page URL (including subdomains) or app.notion.com page URL; empty input clears the field",
  );

// ---------------------------------------------------------------------------
// Option sets
// ---------------------------------------------------------------------------

export const projectStatusValues = [
  "planning",
  "not_started",
  "in_progress",
  "done",
] as const;
export const projectStatusSchema = z.enum(projectStatusValues);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

/**
 * The "live" (not-done) statuses — spelled out rather than derived from
 * `projectStatusValues` so it stays a literal tuple. It is the exact
 * complement of `["done"]` today; the `satisfies` below catches a status
 * being *removed* from `ProjectStatus`, not a fifth status being *added* — a
 * new non-live status must be added here by hand.
 */
export const LIVE_PROJECT_STATUSES = [
  "planning",
  "not_started",
  "in_progress",
] as const satisfies readonly ProjectStatus[];

/**
 * Whether a project is still live (i.e. not `done`). Use this for rules that
 * only make sense on unfinished work — e.g. asking for a budget estimate, which
 * is a forecast and so is meaningless once the spend has already happened.
 */
export const isLiveProjectStatus = (status: ProjectStatus): boolean =>
  (LIVE_PROJECT_STATUSES as readonly ProjectStatus[]).includes(status);

export const projectKindValues = [
  "furniture",
  "workshop",
  "household",
  "renovation",
  "garden",
] as const;
export const projectKindSchema = z.enum(projectKindValues);
export type ProjectKind = z.infer<typeof projectKindSchema>;

export const taskStatusValues = [
  "not_started",
  "later",
  "in_progress",
  "blocked",
  "done",
] as const;
export const taskStatusSchema = z.enum(taskStatusValues);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/**
 * Completion scope for a task list/board/summary query. Omitted (undefined)
 * means "all" — existing generic callers (e.g. `task.list`) keep today's
 * full-history behavior; daily-use views (Next, Board) pass `"open"`
 * explicitly.
 */
export const taskCompletionValues = ["all", "open", "done"] as const;
export const taskCompletionSchema = z.enum(taskCompletionValues);
export type TaskCompletion = z.infer<typeof taskCompletionSchema>;

export const costTypeValues = ["materials", "tools", "services"] as const;
export const costTypeSchema = z.enum(costTypeValues);
export type CostType = z.infer<typeof costTypeSchema>;

/**
 * The trade/discipline a task or expense belongs to (a phase of household
 * work — "plumbing", "electrical", etc.) — shared between `task.trade` and
 * `expense.trade`. Human labels in `TRADE_LABELS` below.
 */
export const tradeValues = [
  "planning",
  "demolition",
  "building",
  "drywall",
  "electrical",
  "plumbing",
  "mechanical",
  "cabinetry",
  "countertop",
  "flooring",
  "millwork",
  "finishes",
  "appliances",
  "landscaping",
  "logistics",
  "metalworking",
  "crafts",
  "auto",
  "other",
] as const;
export const tradeSchema = z.enum(tradeValues);
export type Trade = z.infer<typeof tradeSchema>;

/**
 * Human-facing labels for `tradeValues` — single source of truth shared by
 * server (MCP descriptions, embedding text) and client (selects/badges/chart
 * labels). Never string-match/capitalize the raw enum value for display text.
 */
export const TRADE_LABELS: Record<Trade, string> = {
  planning: "Planning",
  demolition: "Demo & Cleanup",
  building: "Building & Framing",
  drywall: "Drywall",
  electrical: "Electrical & Lighting",
  plumbing: "Plumbing",
  mechanical: "Mechanical / HVAC",
  cabinetry: "Cabinetry",
  countertop: "Countertops",
  flooring: "Flooring",
  millwork: "Trim & Millwork",
  finishes: "Paint & Finishes",
  appliances: "Appliances & Furniture",
  landscaping: "Landscaping",
  logistics: "Logistics & Moving",
  metalworking: "Metalworking",
  crafts: "Arts & Crafts",
  auto: "Auto",
  other: "Other",
};

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

const projectFields = {
  name: z.string().min(1),
  status: projectStatusSchema,
  kind: projectKindSchema.nullable(),
  locations: z.array(z.string()).describe("House/site names, free-form"),
  costEstimate: z.number().nullable().describe("Budget estimate in dollars"),
  // Arbitrary-depth sub-projects (WBS) — a sub-project's own `costEstimate`
  // is its budget envelope; expenses/tasks attribute to it via their
  // existing `projectId`. Cycle/self-parent guards live in
  // repo/project/crud.ts (depth is otherwise unrestricted).
  parentProjectId: projectShortcode.nullable(),
  // Manual OVERRIDES on the derived window, not the window itself. A project's
  // dates are normally rolled up from its own tasks/expenses plus every live
  // sub-project's effective window (see `projectDateWindow`); these two columns
  // only take over when explicitly set — for a project with no content yet, or
  // a deliberate plan wider than what's been recorded. Read
  // `dates.effectiveStart` / `dates.effectiveEnd`, never these, when rendering.
  startDate: plainDate
    .nullable()
    .describe("Manual start override; usually null"),
  endDate: plainDate.nullable().describe("Manual end override; usually null"),
  icon: z.string().nullable().describe("Emoji shown next to the name"),
  notes: z.string().nullable().describe("Freeform markdown"),
  googleDriveFolderUrl,
  notionPageUrl,
};

const projectCreateShape = {
  ...projectFields,
  status: projectStatusSchema.default("planning"),
  kind: projectKindSchema.nullable().default(null),
  locations: z.array(z.string()).default([]),
  costEstimate: z.number().nullable().default(null),
  parentProjectId: projectShortcode.nullable().default(null),
  startDate: plainDate.nullable().default(null),
  endDate: plainDate.nullable().default(null),
  icon: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  googleDriveFolderUrl: googleDriveFolderUrl.default(null),
  notionPageUrl: notionPageUrl.default(null),
};

export const projectCreateInput = z.object(projectCreateShape);
export type ProjectCreateInput = z.infer<typeof projectCreateInput>;

// Every create field optional, with the create-time `.default(...)` stripped
// (see deriveUpdateData — an omitted key must leave the row unchanged, not
// reset to the default); `blockedByIds` is update-only.
export const projectUpdateData = deriveUpdateData(projectCreateShape, {
  extend: {
    blockedByIds: z
      .array(projectShortcode)
      .optional()
      .describe("Full replacement set of blocking-project ids"),
  },
});
export type ProjectUpdateData = z.infer<typeof projectUpdateData>;
export const projectUpdateInput = z.object({
  id: projectShortcode,
  data: projectUpdateData,
});
export type ProjectUpdateInput = z.infer<typeof projectUpdateInput>;

/**
 * Lightweight `{id, name}` projection for pickers/filter selects — no
 * rollups/dependency joins, a single indexed query (see
 * repo/project/lookup.ts's `projectNameOptions`).
 */
export const projectOptionsOut = z.object({
  id: projectShortcode,
  name: z.string(),
  // Carried so a picker can rank by "was this project running on that date?"
  // without a second round trip — see rankProjectSuggestions. These are the
  // EFFECTIVE bounds (override when set, else derived from tasks/expenses/
  // sub-projects), deliberately not the raw override columns: ranking a
  // expense against a stale hand-typed window is what made suggestions miss.
  effectiveStart: plainDate.nullable(),
  effectiveEnd: plainDate.nullable(),
});
export type ProjectOptionsOut = z.infer<typeof projectOptionsOut>;

export const projectFilterFields = {
  ...auditDateFilterFields,
  ...projectRelatedFilterFields,
  status: projectStatusSchema.optional(),
  kind: projectKindSchema.optional(),
  location: z.string().optional().describe("Exact match against locations[]"),
  search: z.string().optional(),
  /** Exclude sub-projects (rows with a non-null `parentProjectId`) from the list. */
  topLevelOnly: z.boolean().optional(),
  /** Only this parent's live sub-projects. */
  parentProjectId: projectShortcode.optional(),
  // Only meaningful alongside `parentProjectId`: expands the filter to the
  // whole live subtree under that parent, not just direct children.
  includeSubProjects: z.boolean().optional(),
};
export const projectFiltersSchema = z.object(projectFilterFields);
export type ProjectFilters = z.infer<typeof projectFiltersSchema>;

export const projectSortableFields = [
  "name",
  "status",
  "kind",
  "startDate",
  "costEstimate",
  "createdAt",
  "updatedAt",
] as const;
export type ProjectSortField = (typeof projectSortableFields)[number];

/**
 * SUM/COUNT rollup over live tasks/expenses, at two scopes (see
 * repo/project/analytics.ts + repo/project/subtree.ts):
 *   - the top-level fields are this project's OWN aggregate (unchanged
 *     since before sub-projects existed);
 *   - `subtree` is the recursive total over this project + every live
 *     descendant — `projectCount` is the live descendant count (0 for a
 *     leaf, so a leaf's `subtree` always equals its own numbers). Computed
 *     in TS at read time, never denormalized onto the row.
 */
/**
 * A project's date window, resolved at read time (see repo/project/subtree.ts's
 * `aggregateSubtreeDates`) and never denormalized — same contract as
 * `projectRollup` below.
 *
 *   content(node)   = min/max over the node's OWN live tasks
 *                     (`dueDate` … `dueEndDate ?? dueDate`) and expenses (`date`)
 *   derived(node)   = content(node) ∪ effective(child) for every live child
 *   effective(node) = the explicit `startDate`/`endDate` override when set,
 *                     otherwise derived(node)
 *
 * Start and end resolve **independently**: a project may carry an explicit start
 * and a derived end, hence the two separate `*Source` discriminators. Note that
 * an override wins even when it's *narrower* than the derived window — that
 * disagreement is surfaced as a `date_window_drift` attention item rather than
 * silently widened, so the stored intent stays visible.
 *
 * Every rendering surface reads `effectiveStart`/`effectiveEnd`.
 */
export const projectDateWindow = z.object({
  derivedStart: plainDate.nullable(),
  derivedEnd: plainDate.nullable(),
  effectiveStart: plainDate.nullable(),
  effectiveEnd: plainDate.nullable(),
  startSource: z.enum(["explicit", "derived", "none"]),
  endSource: z.enum(["explicit", "derived", "none"]),
});
export type ProjectDateWindow = z.infer<typeof projectDateWindow>;

export const projectRollup = z.object({
  spent: z
    .number()
    .describe(
      "SUM(cost) of live expenses — the blended net (actualSpent + committedSpent − contributions), including planned + offsets",
    ),
  // The `spent` figure above blends three economically distinct quantities;
  // these split it so callers can show a true money-out "Actual" that matches
  // the detail hero / BudgetStrip decomposition instead of the net blend.
  actualSpent: z
    .number()
    .describe("SUM(cost) where cost > 0 and not future — money already spent"),
  committedSpent: z
    .number()
    .describe("SUM(cost) where cost > 0 and future — planned, not yet spent"),
  contributions: z
    .number()
    .describe(
      "SUM(-cost) where cost < 0 — offsets/credits, positive magnitude",
    ),
  expenseCount: z.number().int(),
  taskCount: z.number().int(),
  doneTaskCount: z.number().int(),
  subtree: z.object({
    spent: z.number(),
    actualSpent: z.number(),
    committedSpent: z.number(),
    contributions: z.number(),
    expenseCount: z.number().int(),
    taskCount: z.number().int(),
    doneTaskCount: z.number().int(),
    projectCount: z.number().int().describe("Live descendant project count"),
    costEstimate: z
      .number()
      .nullable()
      .describe(
        "SUM of non-null costEstimates; null when the subtree has none",
      ),
  }),
});
export type ProjectRollup = z.infer<typeof projectRollup>;

export const projectOut = z.object({
  id: projectShortcode,
  ...projectFields,
  /** Null when the project has no parent, or the parent is gone/soft-deleted. */
  parentProjectName: z.string().nullable(),
  /** Live sub-project ids (direct children only). */
  childProjectIds: z.array(projectShortcode),
  blockedByIds: z.array(projectShortcode),
  blockingIds: z.array(projectShortcode),
  ...timestampedFields,
  rollup: projectRollup,
  dates: projectDateWindow,
});
export type ProjectOut = z.infer<typeof projectOut>;

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

const taskFields = {
  name: z.string().min(1),
  status: taskStatusSchema,
  projectId: projectShortcode.nullable(),
  /** The optional product/item this task acts on. */
  subjectProductId: productShortcode.nullable(),
  // One level of checklist subtasks — a subtask's own parentTaskId must be
  // null (enforced in repo/task/crud.ts). Parent status stays fully manual;
  // an all-done checklist never auto-completes it.
  parentTaskId: taskShortcode.nullable(),
  dueDate: plainDate.nullable(),
  dueEndDate: plainDate.nullable().describe("End of a due-date range"),
  trade: tradeSchema,
  // Board-only manual priority within a cell (drag-to-prioritize). Null =
  // unranked (derived dueDate/name order); ranked cards sort ahead by
  // ascending sortOrder. Never a table sort field — see taskSortableFields.
  sortOrder: z.number().nullable(),
};

const taskCreateShape = {
  ...taskFields,
  status: taskStatusSchema.default("not_started"),
  projectId: projectShortcode.nullable().default(null),
  subjectProductId: productShortcode.nullable().default(null),
  // If set and either relation is omitted/null, the created task inherits the
  // parent's projectId and subjectProductId (see repo/task/crud.ts's
  // createTask) — one-time at create, no ongoing sync afterwards.
  parentTaskId: taskShortcode.nullable().default(null),
  dueDate: plainDate.nullable().default(null),
  dueEndDate: plainDate.nullable().default(null),
  // New tasks are unranked (land per derived sort); a drag assigns a rank.
  sortOrder: z.number().nullable().default(null),
};

export const taskCreateInput = z.object(taskCreateShape);
export type TaskCreateInput = z.infer<typeof taskCreateInput>;

// Every create field optional, with the create-time `.default(...)` stripped
// (see deriveUpdateData); `blockedByIds` is update-only.
export const taskUpdateData = deriveUpdateData(taskCreateShape, {
  extend: {
    blockedByIds: z
      .array(taskShortcode)
      .optional()
      .describe("Full replacement set of blocking-task ids"),
  },
});
export type TaskUpdateData = z.infer<typeof taskUpdateData>;
export const taskUpdateInput = z.object({
  id: taskShortcode,
  data: taskUpdateData,
});
export type TaskUpdateInput = z.infer<typeof taskUpdateInput>;

/**
 * Bulk "move to project" — `projectId: null` moves every listed task to the
 * inbox (no project). Same nullable-projectId semantics as a single
 * `taskUpdateData.projectId` write, batched over `ids`.
 */
export const taskBulkMoveInput = z.object({
  ids: z.array(taskShortcode).min(1),
  projectId: projectShortcode.nullable(),
});
export type TaskBulkMoveInput = z.infer<typeof taskBulkMoveInput>;

/** Bulk status write — same enum as a single `taskUpdateData.status` write. */
export const taskBulkStatusInput = z.object({
  ids: z.array(taskShortcode).min(1),
  status: taskStatusSchema,
});
export type TaskBulkStatusInput = z.infer<typeof taskBulkStatusInput>;

/** Bulk trade write — same enum as a single `taskUpdateData.trade` write. */
export const taskBulkTradeInput = z.object({
  ids: z.array(taskShortcode).min(1),
  trade: tradeSchema,
});
export type TaskBulkTradeInput = z.infer<typeof taskBulkTradeInput>;

/** Bulk due-date write — same nullable pair as a single task update. */
export const taskBulkDueDateInput = z.object({
  ids: z.array(taskShortcode).min(1),
  dueDate: plainDate.nullable(),
  dueEndDate: plainDate.nullable(),
});
export type TaskBulkDueDateInput = z.infer<typeof taskBulkDueDateInput>;

/**
 * The axis fields a board drag can change on the dragged card — the same
 * subset a single board drop writes (status/project/trade), minus `sortOrder`
 * (which the reorder carries separately). Folded into `taskBulkReorderInput`
 * so a cross-cell drop that materializes ranks applies its move in the same
 * transaction.
 */
export const taskBoardMovePatch = z.object({
  status: taskStatusSchema.optional(),
  projectId: projectShortcode.nullable().optional(),
  trade: tradeSchema.optional(),
});
export type TaskBoardMovePatch = z.infer<typeof taskBoardMovePatch>;

/**
 * Bulk manual-reorder write — the board's "materialize" path (see
 * board-model.ts computeRank). `ranks` re-assigns sparse `sortOrder` values to
 * a run of cards when a single midpoint isn't representable (degenerate gap or
 * an insert into the unranked tail); `move` optionally carries the dragged
 * card's own axis change when the drop also crossed cells. Capped so a
 * pathological cell can't issue an unbounded write.
 */
export const taskBulkReorderInput = z.object({
  ranks: z
    .array(z.object({ id: taskShortcode, sortOrder: z.number() }))
    .min(1)
    .max(200),
  move: z.object({ id: taskShortcode, patch: taskBoardMovePatch }).optional(),
});
export type TaskBulkReorderInput = z.infer<typeof taskBulkReorderInput>;

export const taskFilterFields = {
  ...auditDateFilterFields,
  ...taskRelatedFilterFields,
  status: oneOrMany(taskStatusSchema).optional(),
  projectId: oneOrMany(projectShortcode).optional(),
  subjectProductId: oneOrMany(productShortcode).optional(),
  trade: oneOrMany(tradeSchema).optional(),
  search: z.string().optional(),
  /** Exclude subtasks (rows with a non-null `parentTaskId`) from the list. */
  topLevelOnly: z.boolean().optional(),
  /** Only this parent's live subtasks. */
  parentTaskId: taskShortcode.optional(),
  /**
   * When combined with `projectId`, also match tasks in that project's live
   * descendant sub-projects.
   */
  includeSubProjects: z.boolean().optional(),
  /** Inclusive lower bound on a task's due date (matches `dueDate`). */
  dueFrom: plainDate.optional().describe("Inclusive lower bound on due date"),
  /** Inclusive upper bound on a task's due date (matches `dueDate`). */
  dueTo: plainDate.optional().describe("Inclusive upper bound on due date"),
  /** Completion scope — see `taskCompletionSchema`. Undefined = "all". */
  completion: taskCompletionSchema
    .optional()
    .describe('Undefined = "all" (today\'s default, unchanged)'),
  /**
   * `"none"` matches tasks with `projectId IS NULL` (the Inbox predicate);
   * `"has"` matches those with any project. Combined with `projectId` it
   * **widens** rather than narrows — the repo ORs the two, so
   * `{projectId: [A], projectPresenceFilter: "none"}` means "project A or
   * unassigned". That's what the header filter's `(none)` sentinel produces.
   */
  projectPresenceFilter: presenceFilter,
  /** Presence of a subject-product relationship. */
  subjectProductPresenceFilter: presenceFilter,
};
export const taskFiltersSchema = z.object(taskFilterFields);
export type TaskFilters = z.infer<typeof taskFiltersSchema>;

export const taskSortableFields = [
  "name",
  "status",
  "dueDate",
  "trade",
  // Joined project name — see the resolver in repo/task/lookup.ts.
  "project",
  // Joined subject-product name — see the resolver in repo/task/lookup.ts.
  "subjectProduct",
  "createdAt",
  "updatedAt",
] as const;
export type TaskSortField = (typeof taskSortableFields)[number];

export const taskOut = z.object({
  id: taskShortcode,
  ...taskFields,
  projectName: z.string().nullable(),
  /** Null when there is no subject product, or it is gone/soft-deleted. */
  subjectProductName: z.string().nullable(),
  /** Null when the task has no parent, or the parent is gone/soft-deleted. */
  parentTaskName: z.string().nullable(),
  blockedByIds: z.array(taskShortcode),
  blockingIds: z.array(taskShortcode),
  /** Live subtask count (incl. done ones) — 0 for a subtask itself (one level). */
  subtaskCount: z.number().int(),
  doneSubtaskCount: z.number().int(),
  ...timestampedFields,
});
export type TaskOut = z.infer<typeof taskOut>;

/**
 * Bulk task write output — the updated rows plus any background work the
 * write enqueued (embedding refresh), mirroring inventory's
 * `*ListAndSideEffectsOut` shape.
 */
export const taskListAndSideEffectsOut = z.object({
  items: z.array(taskOut),
  sideEffects: mutationSideEffectsSchema,
});
export type TaskListAndSideEffectsOut = z.infer<
  typeof taskListAndSideEffectsOut
>;

/**
 * Inbox → project promotion: create a new project and move the given tasks
 * onto it in one transaction (see `project.createFromTasks`). Neither side
 * persists if the other fails.
 */
export const createProjectFromTasksInput = z.object({
  taskIds: z.array(taskShortcode).min(1),
  project: projectCreateInput,
});
export type CreateProjectFromTasksInput = z.infer<
  typeof createProjectFromTasksInput
>;

export const createProjectFromTasksOut = z.object({
  project: projectOut,
  tasks: z.array(taskOut),
});
export type CreateProjectFromTasksOut = z.infer<
  typeof createProjectFromTasksOut
>;

// ---------------------------------------------------------------------------
// Actionable tasks (computed unblocked/blocked read — see
// repo/task/actionable.ts for the exact semantics)
// ---------------------------------------------------------------------------

/**
 * Why a task is blocked, plus (for `task`/`project`) a transitive "why"
 * chain: the representative path of entities you'd need to unblock, nearest
 * blocker first. `manual` (the task's own status is `blocked`) carries no
 * chain — there's nothing upstream to walk.
 */
export const blockedReasonSchema = z.object({
  kind: z.enum(["manual", "task", "project"]),
  chain: z.array(
    z.object({
      // Public id (shortcode) for the link. Deliberately a plain string (not
      // the task/project-branded shortcode schema) — a single node type spans
      // both entity kinds, discriminated by `type`.
      id: z.string(),
      name: z.string(),
      status: z.string(),
      type: z.enum(["task", "project"]),
    }),
  ),
});
export type BlockedReason = z.infer<typeof blockedReasonSchema>;

export const actionableTaskOut = z.object({
  id: taskShortcode,
  ...taskFields,
  projectName: z.string().nullable(),
  subjectProductName: z.string().nullable(),
  blockedByIds: z.array(taskShortcode),
  blockingIds: z.array(taskShortcode),
  // Re-declares taskOut's shape rather than extending it (see taskOut) — kept
  // in sync by hand. Actionable/blocked rows are always top-level (subtask
  // rows are excluded — see repo/task/actionable.ts), so these count the
  // row's own live subtasks same as taskOut.
  subtaskCount: z.number().int(),
  doneSubtaskCount: z.number().int(),
  ...timestampedFields,
});
export type ActionableTaskOut = z.infer<typeof actionableTaskOut>;

export const blockedTaskOut = z.object({
  task: taskOut,
  reasons: z.array(blockedReasonSchema),
});
export type BlockedTaskOut = z.infer<typeof blockedTaskOut>;

/**
 * `task.listActionable`'s output: every live, non-done, unblocked task split
 * into `next` (status `not_started`/`in_progress`) and `later` (status
 * `later`) — separate arrays instead of one `actionable` array with an
 * `isLater` flag, since Next/Later render as distinct UI sections. `blocked`
 * carries the reason set + transitive why-chain, unchanged.
 */
export const actionableTasksOut = z.object({
  next: z.array(actionableTaskOut),
  later: z.array(actionableTaskOut),
  blocked: z.array(blockedTaskOut),
});
export type ActionableTasksOut = z.infer<typeof actionableTasksOut>;

/**
 * `task.summary`'s output — cheap counts for the tasks-page summary strip,
 * replacing a full-history fetch. Each count corresponds to a `/tasks` view
 * or filter the UI links to directly.
 */
export const taskSummaryOut = z.object({
  totalOpen: z.number().int(),
  next: z.number().int(),
  later: z.number().int(),
  inbox: z.number().int(),
  overdue: z.number().int(),
  /**
   * A rolling 7-day window (today through +7 days), NOT the calendar week
   * `task-options.ts`'s `resolveDueRange("week")` filter preset uses — the UI
   * labels this tile "Due in 7 days" rather than "Due this week" specifically
   * to avoid implying they're the same count.
   */
  dueThisWeek: z.number().int(),
  blocked: z.number().int(),
});
export type TaskSummaryOut = z.infer<typeof taskSummaryOut>;

/** `task.board`'s input — the axes a board view can scope by. */
export const taskBoardInput = z.object({
  projectId: projectShortcode.optional(),
  includeSubProjects: z.boolean().optional(),
  search: z.string().optional(),
});
export type TaskBoardInput = z.infer<typeof taskBoardInput>;

/**
 * `task.board`'s output: every active (non-done) top-level task the board
 * renders, plus at most 20 recently-completed cards for the collapsed
 * History column/count — full completed history loads separately
 * (`completion: "done"` on `task.list`), not through the board.
 */
export const taskBoardOut = z.object({
  active: z.array(taskOut),
  recentDone: z.array(taskOut),
  doneCount: z.number().int(),
});
export type TaskBoardOut = z.infer<typeof taskBoardOut>;

// ---------------------------------------------------------------------------
// Expense
// ---------------------------------------------------------------------------

const expenseFields = {
  name: z.string().min(1),
  cost: wholeCentAmount.nullable().describe("Dollars"),
  date: plainDate,
  costType: costTypeSchema,
  trade: tradeSchema,
  url: z.string().nullable(),
  notes: z.string().nullable(),
  future: z.boolean().describe("Planned/not-yet-made expense"),
  projectId: projectShortcode.nullable(),
  productId: productShortcode
    .nullable()
    .describe(
      "Optional link to the product this expense bought. A negative-cost expense on the same product records an exit (sale, return, or a 0-cost disposal).",
    ),
  productQuantity: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe(
      "Whole product units covered by this expense; null means the receipt does not establish quantity.",
    ),
  /**
   * Where it was bought. **No longer a column** — resolved through
   * `expense.purchaseId → Purchase → Vendor` (see `dbExpenseToAPI`). Still
   * accepted by name on create/update, where the repo resolves it via
   * `findOrCreateVendor` + `findOrCreatePurchase` inside the existing
   * transaction; that's what keeps MCP, quick-add and the purchase-import skill
   * unchanged across the split.
   */
  vendor: z.string().nullable().describe("Where it was bought"),
  orderId: z
    .string()
    .nullable()
    .describe(
      'The vendor\'s order/receipt id — e.g. Amazon "111-1234567-1234567", Home Depot "WN63446464". Free text; formats differ per retailer. Expenses sharing one orderId belong to the same Purchase rather than a two-column string match.',
    ),
};

const expenseCreateShape = {
  ...expenseFields,
  /**
   * Attach directly to a known Purchase, bypassing the `{vendor, orderId}`
   * name-resolution path. The precise form, for callers that already hold a
   * Purchase id (the Purchase detail page's "add an Expense"); `vendor`/`orderId`
   * stay the ergonomic form for importers and quick-add. When both are given,
   * this wins — an explicit id is never a guess.
   */
  purchaseId: purchaseShortcode.nullable().default(null),
  cost: wholeCentAmount.nullable().default(null),
  date: plainDate,
  url: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  future: z.boolean().default(false),
  projectId: projectShortcode.nullable().default(null),
  productId: productShortcode.nullable().default(null),
  productQuantity: z.number().int().positive().nullable().default(null),
  vendor: z.string().nullable().default(null),
  orderId: z.string().nullable().default(null),
};

export const expenseCreateInput = z.object(expenseCreateShape);
export type ExpenseCreateInput = z.infer<typeof expenseCreateInput>;

// Every create field optional, with the create-time `.default(...)` stripped
// (see deriveUpdateData).
export const expenseUpdateData = deriveUpdateData(expenseCreateShape);
export type ExpenseUpdateData = z.infer<typeof expenseUpdateData>;
export const expenseUpdateInput = z.object({
  id: expenseShortcode,
  data: expenseUpdateData,
});
export type ExpenseUpdateInput = z.infer<typeof expenseUpdateInput>;

/**
 * Bulk "move to project" — `projectId: null` moves every listed expense to
 * the inbox (no project). Same nullable-projectId semantics as a single
 * `expenseUpdateData.projectId` write, batched over `ids`.
 */
export const expenseBulkMoveInput = z.object({
  ids: z.array(expenseShortcode).min(1),
  projectId: projectShortcode.nullable(),
});
export type ExpenseBulkMoveInput = z.infer<typeof expenseBulkMoveInput>;

/** Bulk trade write — same enum as a single `expenseUpdateData.trade` write. */
export const expenseBulkTradeInput = z.object({
  ids: z.array(expenseShortcode).min(1),
  trade: tradeSchema,
});
export type ExpenseBulkTradeInput = z.infer<typeof expenseBulkTradeInput>;

/** Bulk cost-type write — same enum as a single `expenseUpdateData.costType`. */
export const expenseBulkCostTypeInput = z.object({
  ids: z.array(expenseShortcode).min(1),
  costType: costTypeSchema,
});
export type ExpenseBulkCostTypeInput = z.infer<typeof expenseBulkCostTypeInput>;

export const expenseFilterFields = {
  ...auditDateFilterFields,
  ...expenseRelatedFilterFields,
  // `oneOrMany`: the header filters are multi-select, but scalar MCP callers
  // stay valid. Resolved with `eqAny` in the repo.
  costType: oneOrMany(costTypeSchema).optional(),
  trade: oneOrMany(tradeSchema).optional(),
  projectId: oneOrMany(projectShortcode).optional(),
  // Only meaningful alongside `projectId`: expands the filter to the project
  // plus every live descendant (sub-project subtree).
  includeSubProjects: z.boolean().optional(),
  /**
   * `"none"` matches expenses with `projectId IS NULL` — the unassigned-spend
   * worklist. Mirrors `taskFilterFields.projectPresenceFilter`, including the
   * OR-with-`projectId` semantics documented there.
   */
  projectPresenceFilter: presenceFilter,
  productId: productShortcode.optional(),
  productPresenceFilter: presenceFilter,
  /**
   * Vendor **ids**, resolved through `expense.purchaseId → Purchase.vendorId`.
   *
   * Ids rather than the old exact-match-on-free-text: `Vendor` is a real roster
   * now, so the picklist has a primary key to filter on and the class of bug the
   * exact match existed to prevent ("Amazon (254)" also dragging in "Amazon
   * Business") is gone by construction rather than by discipline.
   *
   * Still its own filter, deliberately NOT folded into `search`:
   * `buildSearchConditions` ANDs its entries, so a second predicate sharing the
   * `search` term would mean `name ILIKE q AND vendor matches q` — and most rows
   * have no vendor, which would silently zero out expense search.
   */
  vendorId: oneOrMany(vendorShortcode).optional(),
  /**
   * `"none"` matches expenses with no purchase attached — the
   * where-did-this-come-from worklist. Since `purchase.vendorId` is NOT NULL,
   * "no vendor" and "no purchase" are the same predicate: `purchaseId IS NULL`.
   * ORs with `vendorId` rather than ANDing, so "Amazon or no vendor recorded" is
   * one filter.
   */
  vendorPresenceFilter: presenceFilter,
  future: z.boolean().optional(),
  /**
   * Substring match on the expense NAME. `oneOrMany`, mirroring
   * `costType`/`trade`/`projectId` — a bare string still behaves exactly as it
   * always did, and several terms can now be passed at once.
   *
   * Several terms **OR** rather than AND. That's the point: the ledger names
   * the *thing*, not the product (a Festool vacuum is booked as
   * `dust extractor`, a Bosch miter saw as `chop saw`), so a caller guessing at
   * synonyms wants any of them to hit. ANDing would make a two-term search
   * strictly worse than a one-term search.
   *
   * Resolved in the repo as an OR of `formatSearchTerm`s passed as an extra
   * condition, NOT as a `buildSearchConditions` search entry — that helper ANDs
   * its `searchFilters`.
   */
  search: oneOrMany(z.string()).optional(),
  /**
   * Substring match on `notes`. Deliberately its OWN field rather than folded
   * into `search`, for the same reason `vendorId` is: `buildSearchConditions`
   * ANDs its `searchFilters` entries, so a second entry sharing the `search`
   * term would mean `name ILIKE q AND notes ILIKE q` — and most rows have no
   * notes, which would silently zero out expense search.
   *
   * Notes carry an import's provenance (line itemizations on aggregate rows,
   * refund documentation, legacy `"<Vendor> order <ID>"` prose), so this is how
   * you find the rows a previous pass touched.
   */
  notesSearch: z.string().optional(),
  /**
   * Substring match on `url`. Own field for the same AND-vs-OR reason as
   * `notesSearch`. Pre-roster rows routinely carry a bare store name as the
   * whole `url` value (`home depot`, `lowes`), so this is the vendor-marker
   * sweep.
   */
  urlSearch: z.string().optional(),
  dateFrom: plainDate
    .optional()
    .describe("Inclusive lower bound on expense date"),
  dateTo: plainDate
    .optional()
    .describe("Inclusive upper bound on expense date"),
  /**
   * Inclusive bounds on `cost`, in dollars — the money window the ledger has
   * never had. (Its absence is why 61 of 318 audited raw-SQL statements existed
   * at all: they were writing `cost BETWEEN a AND b` by hand.)
   *
   * `z.coerce` is load-bearing, not decoration: these arrive from the URL as
   * strings (`?costMin=500`), and a bare `z.number()` rejects `"500"`.
   *
   * Rows with a null `cost` fall out of any window by plain SQL comparison
   * semantics, exactly as null-`date` rows do for the date bounds. That is
   * intended, not a gap: `costPresenceFilter: "none"` is the filter for "no
   * cost recorded".
   *
   * Negative bounds are meaningful and supported — credits are real in this
   * ledger (refunds, and the family wedding contributions), so `costMax: 0` is
   * the credits-only worklist. Never assume a lower bound of zero.
   */
  costMin: z.coerce
    .number()
    .optional()
    .describe("Inclusive lower bound on expense cost, in dollars"),
  costMax: z.coerce
    .number()
    .optional()
    .describe("Inclusive upper bound on expense cost, in dollars"),
  /**
   * `"none"` matches expenses with a null `cost`; `"has"` matches expenses
   * with a non-null `cost`. Combined with `trade: "other"`, `"none"` is the
   * Unclassified-expense predicate (`trade='other' AND cost IS NULL`) —
   * deliberately NOT a `costType` value, since `costType` stays a clean
   * 3-value enum.
   */
  costPresenceFilter: presenceFilter,
  /**
   * Whole-unit receipt quantity is deliberately nullable: null means the
   * source paperwork did not establish a count. Bounds are inclusive and only
   * match rows with a recorded quantity, as ordinary SQL comparisons do.
   */
  productQuantityPresenceFilter: presenceFilter,
  productQuantityMin: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Inclusive lower bound on recorded product quantity"),
  productQuantityMax: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Inclusive upper bound on recorded product quantity"),
  /**
   * `"none"` matches expenses with a null `orderId`; `"has"` matches
   * expenses that carry one. Same shape as `costPresenceFilter` — there's no
   * bounded order-id picklist (free text, one per retailer's format), so this
   * only distinguishes reconciled-to-an-order vs. not.
   */
  orderIdPresenceFilter: presenceFilter,
  /**
   * Exact match on the vendor's own order id — the "show me the rest of this
   * order" scope behind `/expenses?order=…`.
   *
   * Exact (`eqAny`) for the same reason `vendor` is: an order id is an
   * identifier, not a search term, and a substring match would let
   * "111-1234567-1234567" also drag in a longer id that contains it.
   *
   * Every link that sets this ALSO sets `vendor` (or
   * `vendorPresenceFilter: "none"`), because an order id is only unique within
   * a vendor — short ones like Tool Nirvana's "#11325" would otherwise collide.
   * The two together are the group key.
   */
  orderId: oneOrMany(z.string()).optional(),
  /**
   * Exact match on the purchase itself — the "show me the rest of this purchase"
   * scope, seeded from the URL only (a deep link from the purchase's own detail
   * page), same shape as `productId` above. Simpler than either
   * `vendorId`/`orderId`: `purchaseId` is a column ON `expense`, not resolved
   * through `Purchase` like they are, so the repo needs no `chargeCondition`
   * sub-select hop for this one — a plain `eqAny`.
   *
   * No dedicated presence field: `vendorPresenceFilter` already means
   * `purchaseId IS NULL`, since `purchase.vendorId` is NOT NULL (see above).
   */
  purchaseId: oneOrMany(purchaseShortcode).optional(),
};
export const expenseFiltersSchema = z.object(expenseFilterFields);
export type ExpenseFilters = z.infer<typeof expenseFiltersSchema>;

export const expenseSortableFields = [
  "name",
  "cost",
  "productQuantity",
  "date",
  "costType",
  // `trade` is a plain text column (alphabetical). `project`/`product` are
  // joined names, resolved by correlated subqueries in repo/expense/lookup.ts.
  "trade",
  "project",
  "product",
  "vendor",
  "orderId",
  "createdAt",
  "updatedAt",
] as const;
export type ExpenseSortField = (typeof expenseSortableFields)[number];

export const expenseOut = z.object({
  id: expenseShortcode,
  ...expenseFields,
  /**
   * The purchase this expense belongs to. Null for rows with no vendor recorded —
   * there's no transaction to attach them to, and inventing one would fabricate
   * a purchase that was never recorded.
   */
  purchaseId: purchaseShortcode.nullable(),
  /** The linked purchase's own date, distinct from this expense's ledger date. */
  purchaseDate: plainDate.nullable(),
  /** The purchase's vendor, denormalized onto the expense so tables can link it. */
  vendorId: vendorShortcode.nullable(),
  projectName: z.string().nullable(),
  // Null when unlinked *or* when the linked product has been soft-deleted —
  // product deletion deliberately does not block on referencing expenses
  // (unlike project deletion), so this null branch is routinely reachable.
  productName: z.string().nullable(),
  ...timestampedFields,
});
export type ExpenseOut = z.infer<typeof expenseOut>;

/**
 * Result of the import-oriented expense cleanup operation.  These public ids
 * let a caller safely continue the "remove bad lines, then inspect the now
 * empty purchases" workflow without exposing database UUIDs.
 */
export const deleteExpensesWithPurchaseEffectsOut = z.object({
  deleted: z.number().int().nonnegative(),
  deletedIds: z.array(expenseShortcode),
  affectedPurchaseIds: z.array(purchaseShortcode),
  newlyEmptyPurchaseIds: z.array(purchaseShortcode),
});
export type DeleteExpensesWithPurchaseEffectsOut = z.infer<
  typeof deleteExpensesWithPurchaseEffectsOut
>;

export const deleteExpensesWithPurchaseEffectsInput = z.strictObject({
  ids: z
    .array(expenseShortcode)
    .min(1)
    .max(200)
    .superRefine((ids, ctx) => {
      const seen = new Set<string>();
      for (const [index, id] of ids.entries()) {
        if (seen.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: [index],
            message: `Duplicate expense id ${id}; each expense may be deleted once.`,
          });
        }
        seen.add(id);
      }
    }),
});

/**
 * Bulk expense write output — the updated rows plus any background work the
 * write enqueued (embedding refresh), mirroring inventory's
 * `*ListAndSideEffectsOut` shape.
 */
export const expenseListAndSideEffectsOut = z.object({
  items: z.array(expenseOut),
  sideEffects: mutationSideEffectsSchema,
});
export type ExpenseListAndSideEffectsOut = z.infer<
  typeof expenseListAndSideEffectsOut
>;

// ---------------------------------------------------------------------------
// Expense analytics (server-side chart aggregates — see
// repo/expense/analytics.ts for the SQL)
// ---------------------------------------------------------------------------

/**
 * `expense.analytics`'s input is `expenseFiltersSchema` directly — the SAME
 * shape as the ledger's filters — so ledger totals and analytics totals
 * always agree under the same filter set. No separate alias: a value-level
 * re-export of the identical schema is a duplicate export, not a real type.
 */

/** actual+committed+credits+net+count, the shared shape every aggregate row carries. */
const expenseAggregateFields = {
  actual: z.number(),
  committed: z.number(),
  credits: z.number(),
  net: z.number(),
  count: z.number().int(),
};

export const expenseAnalyticsSummary = z.object({
  ...expenseAggregateFields,
  actualCount: z.number().int(),
  plannedCount: z.number().int(),
});
export type ExpenseAnalyticsSummary = z.infer<typeof expenseAnalyticsSummary>;

export const expenseCostTypeAggregate = z.object({
  costType: costTypeSchema,
  ...expenseAggregateFields,
});
export type ExpenseCostTypeAggregate = z.infer<typeof expenseCostTypeAggregate>;

export const expenseTradeAggregate = z.object({
  trade: tradeSchema,
  ...expenseAggregateFields,
});
export type ExpenseTradeAggregate = z.infer<typeof expenseTradeAggregate>;

export const expenseTradeCostAggregate = z.object({
  trade: tradeSchema,
  costType: costTypeSchema,
  ...expenseAggregateFields,
});
export type ExpenseTradeCostAggregate = z.infer<
  typeof expenseTradeCostAggregate
>;

export const expenseMonthlyAggregate = z.object({
  month: z.string().describe('"yyyy-MM"'),
  ...expenseAggregateFields,
});
export type ExpenseMonthlyAggregate = z.infer<typeof expenseMonthlyAggregate>;

export const expenseCumulativePoint = z.object({
  month: z.string().describe('"yyyy-MM"'),
  cumulativeNet: z.number(),
});
export type ExpenseCumulativePoint = z.infer<typeof expenseCumulativePoint>;

export const expenseProjectAggregate = z.object({
  projectId: projectShortcode,
  projectName: z.string(),
  ...expenseAggregateFields,
});
export type ExpenseProjectAggregate = z.infer<typeof expenseProjectAggregate>;

/**
 * Spend grouped by the vendor the money went to, resolved through
 * `expense.purchaseId → Purchase.vendorId → Vendor`.
 *
 * Like `byProject`, this is an INNER join, so it deliberately does **not** sum
 * to `summary.net`: every Expense with no Purchase attached (no vendor recorded)
 * is excluded, and there are ~193 of those. That asymmetry is the same one
 * `byProject` already has, and it is the honest shape — a left join would
 * invent an "unknown vendor" bucket that is really "we never wrote it down".
 * Read the gap between `sum(byVendor.net)` and `summary.net` as the size of the
 * unattributed tail, not as a bug.
 */
export const expenseVendorAggregate = z.object({
  vendorId: vendorShortcode,
  vendorName: z.string(),
  ...expenseAggregateFields,
});
export type ExpenseVendorAggregate = z.infer<typeof expenseVendorAggregate>;

/**
 * `expense.analytics`'s output — chart-ready aggregates computed server-side
 * (SQL GROUP BYs), replacing client-side computation over the full
 * `expense.chartData` fetch-all. Empty categories are omitted from each
 * array; the UI owns presentation ordering from the shared enum definitions.
 */
export const expenseAnalyticsOut = z.object({
  summary: expenseAnalyticsSummary,
  byCostType: z.array(expenseCostTypeAggregate),
  byTrade: z.array(expenseTradeAggregate),
  tradeCostMatrix: z.array(expenseTradeCostAggregate),
  monthly: z.array(expenseMonthlyAggregate),
  cumulative: z.array(expenseCumulativePoint),
  byProject: z.array(expenseProjectAggregate),
  byVendor: z.array(expenseVendorAggregate),
});
export type ExpenseAnalyticsOut = z.infer<typeof expenseAnalyticsOut>;

// ---------------------------------------------------------------------------
// Reconciliation matcher (match_expenses)
// ---------------------------------------------------------------------------

/**
 * The household's sales-tax rate, 8.625%.
 *
 * Used **only to LABEL** a candidate, never to match one — see `taxRate` on
 * `expenseMatchInput`. Lives here rather than beside `RECONCILIATION_TOLERANCE`
 * in ./purchase because that module imports from this one.
 */
export const HOUSE_TAX_RATE = 0.08625;

/** Default half-widths of the amount window, as fractions of the row amount. */
export const MATCH_TOLERANCE_LOW = 0.1;
export const MATCH_TOLERANCE_HIGH = 0.15;
/** Dollars. Below this, a relative band is too narrow to be useful. */
export const MATCH_AMOUNT_FLOOR = 1.0;
/** Largest batch one `match_expenses` call accepts. */
export const MATCH_MAX_ROWS = 200;

/** One line of a vendor export, to be matched against the ledger. */
export const expenseMatchRow = z.object({
  /** Caller's own id for this row, echoed back on the result. Must be unique. */
  key: z.string().min(1),
  date: plainDate,
  /**
   * Signed dollars. A refund or sale is NEGATIVE, and the amount window is
   * computed on the signed value — see `expenseMatchInput`.
   */
  amount: z.number(),
  /** The export's description. Used ONLY to grade candidates by name overlap. */
  label: z.string().optional(),
  /** The vendor's own order/receipt id, when the export line carries one. */
  orderId: z.string().optional(),
  /** Vendor name, echoed for context. Not used as a predicate. */
  vendor: z.string().optional(),
});
export type ExpenseMatchRow = z.infer<typeof expenseMatchRow>;

export const expenseMatchInput = z.object({
  rows: z.array(expenseMatchRow).min(1).max(MATCH_MAX_ROWS),
  /** Inclusive +/- day window for the amount arm. Order-id hits ignore it. */
  dayWindow: z.number().int().min(0).max(365).default(30),
  /**
   * How far BELOW the row amount a ledger cost may sit, as a fraction — the
   * pre-tax-entry direction.
   */
  amountToleranceLow: z.number().min(0).max(1).default(MATCH_TOLERANCE_LOW),
  /**
   * How far ABOVE, as a fraction — tax plus additive fees (shipping, core
   * charges). Asymmetric on purpose: the two distortions are not symmetric.
   */
  amountToleranceHigh: z.number().min(0).max(1).default(MATCH_TOLERANCE_HIGH),
  /**
   * Absolute dollar floor on the window: the half-width is
   * `max(relative, floor)`.
   *
   * Load-bearing, not cosmetic. Tolerances must be relative (+/-$0.25 is sensible
   * at $200 and meaningless at $1), but a purely relative band collapses to
   * nothing at small amounts — which is how a $0.93 order false-matched a $1.00
   * ledger row and had to be reverted.
   */
  amountFloor: z.number().min(0).default(MATCH_AMOUNT_FLOOR),
  /**
   * **Labeling only. Never a matching mechanism.**
   *
   * Classifies each candidate's `cost / amount` ratio as
   * `exact` | `plus_tax` | `pre_tax` | `other`. Matching uses one wide window
   * instead, because tax is MULTIPLICATIVE while fees are ADDITIVE and no single
   * band catches both — so a residual of exactly `9.99` surfaces as a plain
   * number a human recognizes as shipping, where a discrete
   * `cost x 1.08625`-style hypothesis would have silently rejected it.
   */
  taxRate: z.number().min(0).max(1).default(HOUSE_TAX_RATE),
  maxCandidatesPerRow: z.number().int().min(1).max(50).default(10),
});
export type ExpenseMatchInput = z.input<typeof expenseMatchInput>;
/** Post-parse shape: every default applied, so the repo takes no optionals. */
export type ExpenseMatchOptions = z.output<typeof expenseMatchInput>;

/** Which arm produced a candidate. Order-id hits always outrank amount+date. */
export const expenseMatchedOn = z.enum(["order_id", "amount_date"]);
export type ExpenseMatchedOn = z.infer<typeof expenseMatchedOn>;

/** How a candidate's `cost / amount` ratio reads against `taxRate`. */
export const expenseMatchRatioLabel = z.enum([
  "exact",
  "plus_tax",
  "pre_tax",
  "other",
]);
export type ExpenseMatchRatioLabel = z.infer<typeof expenseMatchRatioLabel>;

/** Compact order context when a matched Expense is already filed to a Purchase. */
export const expenseMatchPurchaseContext = z.object({
  id: purchaseShortcode,
  vendorName: z.string().nullable(),
  orderId: z.string().nullable(),
  expenseCount: z.number().int(),
  expenseTotal: z.number(),
  statedTotal: z.number().nullable(),
  financialReconciliation: financialReconciliationSummary,
});

export const expenseMatchCandidate = z.object({
  expenseId: expenseShortcode,
  name: z.string(),
  cost: z.number().nullable(),
  date: plainDate,
  /** Planned spend. Included, never filtered — an export line often IS one. */
  future: z.boolean(),
  notes: z.string().nullable(),
  vendorName: z.string().nullable(),
  orderId: z.string().nullable(),
  projectName: z.string().nullable(),
  productName: z.string().nullable(),
  /** Existing order context; null when the Expense has not been filed yet. */
  purchase: expenseMatchPurchaseContext.nullable(),
  matchedOn: expenseMatchedOn,
  /**
   * Does this row's vendor agree with the one on the export line?
   *
   * `null` = nothing to compare (the export line carried no vendor, or the
   * Expense has no Purchase) — unknown, NOT clean. `false` is a real conflict.
   *
   * Load-bearing on an `order_id` hit: an order id is only unique WITHIN a
   * vendor (`Purchase_vendorId_orderId_key`), so a short id can collide across
   * retailers. A conflicting order-id hit is demoted below every amount+date
   * candidate rather than keeping the top slot it would otherwise take.
   */
  vendorMatch: z.boolean().nullable(),
  /** `expense.date - row.date` in days. Null when the ledger row has no date. */
  dayDelta: z.number().int().nullable(),
  /** `expense.cost - row.amount`, signed dollars. */
  amountDelta: z.number().nullable(),
  /** `expense.cost / row.amount`. Null when the row amount is 0. */
  ratio: z.number().nullable(),
  ratioLabel: expenseMatchRatioLabel,
  /**
   * Shared non-stopword tokens between the export label and the ledger name.
   * A GRADING signal only — never a filter. Zero overlap is common on true
   * matches, because this ledger names the thing rather than the product.
   */
  tokenOverlap: z.number().int(),
});
export type ExpenseMatchCandidate = z.infer<typeof expenseMatchCandidate>;

export const expenseMatchOut = z.object({
  matches: z.array(
    z.object({
      key: z.string(),
      candidates: z.array(expenseMatchCandidate),
    }),
  ),
  /** Keys that produced no candidate at all. */
  unmatched: z.array(z.string()),
  summary: z.object({
    rowsIn: z.number().int(),
    rowsWithCandidates: z.number().int(),
    /** Input rows that got at least one order-id hit — the strongest key. */
    exactOrderIdHits: z.number().int(),
  }),
});
export type ExpenseMatchOut = z.infer<typeof expenseMatchOut>;

/**
 * One cell of the project x trade expense-count matrix — how many expenses of
 * a given trade a project has already absorbed. Ranks project suggestions for
 * an unassigned expense; see repo/expense/analytics.ts.
 */
export const expenseTradeAffinityOut = z.object({
  projectId: projectShortcode,
  trade: tradeSchema,
  count: z.number(),
});
export type ExpenseTradeAffinityOut = z.infer<typeof expenseTradeAffinityOut>;

// ---------------------------------------------------------------------------
// MCP / dashboard projections
// ---------------------------------------------------------------------------

export const projectMcpListOut = createPaginatedResponseSchema(projectOut);
/** MCP aliases retained for the deliberately lean tool catalog imports. */
export const taskMcpListOut = createPaginatedResponseSchema(taskOut);
export const expenseMcpListOut = createPaginatedResponseSchema(expenseOut);

// ---------------------------------------------------------------------------
// Project dashboard: bounded Overview summary + on-demand portfolio
// analytics (replaces the old single `project.dashboard` fetch-all — see
// repo/project/dashboard-summary.ts / repo/project/analytics.ts)
// ---------------------------------------------------------------------------

/**
 * Shared scope filters for both dashboard endpoints. Empty/omitted
 * `statusScope` means **no status condition** — all four statuses, not just
 * the live ones.
 *
 * A date window (`dateFrom`/`dateTo`) matches a project whose explicit
 * `startDate`/`endDate` override overlaps it **or** which owns a dated task or
 * expense inside it — so a project with both override columns null is no
 * longer dropped on that basis alone. Only a project with neither an override
 * nor any dated content of its own falls out, and exactly those are counted as
 * `hiddenByDate.projects`. Non-recursive: a parent matches on its own content,
 * not its children's (see repo/project/dashboard-shared.ts).
 */
const projectDashboardFilterFields = {
  statusScope: z.array(projectStatusSchema).optional(),
  kinds: z.array(projectKindSchema).optional(),
  locations: z.array(z.string()).optional(),
  search: z.string().optional(),
  dateFrom: plainDate.optional(),
  dateTo: plainDate.optional(),
};
export const projectDashboardFiltersSchema = z.object(
  projectDashboardFilterFields,
);
export type ProjectDashboardFilters = z.infer<
  typeof projectDashboardFiltersSchema
>;

/**
 * `project.dashboardSummary`'s input is `projectDashboardFiltersSchema`
 * directly — no separate value alias (a re-export of the identical schema is
 * a duplicate export, not a real type). Kept as a type-only alias since
 * `repo/project/dashboard-summary.ts` names it explicitly.
 */
export type ProjectDashboardSummaryInput = ProjectDashboardFilters;

/**
 * `project.portfolioAnalytics`'s input is now identical to
 * `projectDashboardFiltersSchema` (both scopes gained `dateFrom`/`dateTo`) —
 * no separate value alias, matching `ProjectDashboardSummaryInput` above.
 */
export type ProjectPortfolioAnalyticsInput = ProjectDashboardFilters;

export const projectAttentionTypeValues = [
  "overdue_task",
  "stalled_project",
  "missing_budget",
  "past_due_planned_expense",
  "unclassified_expense",
  "blocked_work",
  // A manual startDate/endDate override that now hides real work — the derived
  // window (tasks, expenses, sub-projects) falls OUTSIDE it. Only fires when
  // the override is too narrow; a deliberately wider one is intent, not drift.
  "date_window_drift",
] as const;
export const projectAttentionTypeSchema = z.enum(projectAttentionTypeValues);
export type ProjectAttentionType = z.infer<typeof projectAttentionTypeSchema>;

/**
 * One Needs Attention row. `entityId`/`entityType` identify what to link to;
 * `date`/`amount` carry whichever of the two is relevant to `type` (e.g. an
 * overdue task's due date, or a missing-budget project's spend-to-date).
 */
export const projectAttentionItemSchema = z.object({
  /**
   * Stable unique identity for this row — the React key both renderers use.
   *
   * `(type, entityId)` is NOT unique and can't be: `date_window_drift` checks
   * the start and end overrides independently, so a project narrowed on both
   * sides legitimately produces two rows for the same project under the same
   * rule. Keying on type+entityId collided there, and React's duplicate-key
   * behavior is explicitly unsupported — rows could be dropped, so the section
   * badge stopped matching what rendered. Rules that can emit more than one row
   * per entity append a discriminator (see `attentionKey`).
   */
  key: z.string(),
  type: projectAttentionTypeSchema,
  severity: z.enum(["info", "warning", "critical"]),
  description: z.string(),
  entityType: z.enum(["project", "task", "expense"]),
  entityId: anyShortcodeSchema(["project", "task", "expense"] satisfies [
    ShortcodeEntity,
    ...ShortcodeEntity[],
  ]),
  date: plainDate.nullable(),
  amount: z.number().nullable(),
  href: z.string().describe("Direct link to the corrective view"),
});
export type ProjectAttentionItem = z.infer<typeof projectAttentionItemSchema>;

export const projectTaskStatusBreakdown = z.object({
  projectId: projectShortcode,
  notStarted: z.number().int(),
  later: z.number().int(),
  inProgress: z.number().int(),
  blocked: z.number().int(),
  done: z.number().int(),
});
export type ProjectTaskStatusBreakdown = z.infer<
  typeof projectTaskStatusBreakdown
>;

export const projectFilterOptionsOut = z.object({
  kinds: z.array(projectKindSchema),
  locations: z.array(z.string()),
  /**
   * Every calendar year (`"YYYY"`) the portfolio has data in — the union of
   * expense dates, task effective due dates, and project start/end dates —
   * newest first. Computed server-side (three `selectDistinct`s) so the Date
   * filter row offers the same year chips on every tab; deriving it
   * client-side from the Data view's fetch-alls made the chips disappear on a
   * fresh Overview/Analytics load.
   */
  years: z.array(z.string()),
});
export type ProjectFilterOptionsOut = z.infer<typeof projectFilterOptionsOut>;

/**
 * `project.dashboardSummary`'s output — everything `/projects?view=overview`
 * renders: summary counts, the active-project list (with rollups, via
 * `projectOut`), per-project task-status breakdown, upcoming tasks, Needs
 * Attention items, filter option sets, and the completed-project count (for
 * the History view's link, without shipping the rows themselves).
 */
export const projectDashboardSummaryOut = z.object({
  summary: z.object({
    activeProjectCount: z.number().int(),
    openTaskCount: z.number().int(),
    actualSpend: z.number(),
    committedSpend: z.number(),
  }),
  projects: z.array(projectOut),
  taskStatusByProject: z.array(projectTaskStatusBreakdown),
  nextTasks: z.array(taskOut),
  attention: z.array(projectAttentionItemSchema),
  filterOptions: projectFilterOptionsOut,
  /**
   * How many rows the active date window (`dateFrom`/`dateTo`) removed for
   * having NO date at all, per entity — the honest footnote under the date
   * chips ("12 undated expenses hidden"). All three are 0 when no window is
   * set. A row that has a date but falls outside the window is NOT counted:
   * it's excluded on its own merits, which the chip already says.
   */
  hiddenByDate: z.object({
    projects: z.number().int(),
    tasks: z.number().int(),
    expenses: z.number().int(),
  }),
  completedCount: z.number().int(),
});
export type ProjectDashboardSummaryOut = z.infer<
  typeof projectDashboardSummaryOut
>;

/**
 * `project.portfolioAnalytics`'s output — the chart aggregates that used to
 * ride along in `project.dashboard`'s full task/expense arrays, now computed
 * server-side and loaded only when `view=analytics` is selected.
 */
export const projectPortfolioAnalyticsOut = z.object({
  costVsEstimate: z.array(
    z.object({
      projectId: projectShortcode,
      projectName: z.string(),
      actual: z.number(),
      committed: z.number(),
      estimate: z.number().nullable(),
    }),
  ),
  spendingByProject: z.array(
    z.object({
      projectId: projectShortcode,
      projectName: z.string(),
      spend: z.number(),
    }),
  ),
  monthlySpend: z.array(expenseMonthlyAggregate),
  plannedVsActual: z.array(
    z.object({ month: z.string(), planned: z.number(), actual: z.number() }),
  ),
  tradeActivity: z.array(expenseTradeAggregate),
  taskHeatmap: z.array(
    z.object({
      projectId: projectShortcode,
      projectName: z.string(),
      openTaskCount: z.number().int(),
    }),
  ),
});
export type ProjectPortfolioAnalyticsOut = z.infer<
  typeof projectPortfolioAnalyticsOut
>;
