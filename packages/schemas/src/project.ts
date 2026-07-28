import { z } from "zod";
import { mutationSideEffectsSchema } from "./background-jobs";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import { productId, projectId, purchaseId, taskId } from "./identifiers";
import {
  createPaginatedResponseSchema,
  oneOrMany,
  presenceFilter,
} from "./pagination";

/**
 * Home-project tracker schemas: `project` (a household undertaking), `task`
 * (a step inside one), and `purchase` (a spend, usually attached to one).
 * Migrated from the retired Notion databases; option sets are carried over
 * verbatim (emoji stripped). Cost/progress rollups are SQL aggregates over
 * live purchases/tasks — never denormalized onto the project row.
 *
 * `locations` is deliberately a free-form string array (house names live in
 * the DB, not in committed code); filter options derive from the data.
 */

/** A calendar day as a plain "YYYY-MM-DD" string, timezone-free. */
export const plainDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .describe('Calendar day as "YYYY-MM-DD"');

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
 * The trade/discipline a task or purchase belongs to (a phase of household
 * work — "plumbing", "electrical", etc.) — shared between `task.trade` and
 * `purchase.trade`. Human labels in `TRADE_LABELS` below.
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
  // is its budget envelope; purchases/tasks attribute to it via their
  // existing `projectId`. Cycle/self-parent guards live in
  // repo/project/crud.ts (depth is otherwise unrestricted).
  parentProjectId: projectId.nullable(),
  startDate: plainDate.nullable(),
  endDate: plainDate.nullable(),
  icon: z.string().nullable().describe("Emoji shown next to the name"),
  notes: z.string().nullable().describe("Freeform markdown"),
};

const projectCreateShape = {
  ...projectFields,
  status: projectStatusSchema.default("planning"),
  kind: projectKindSchema.nullable().default(null),
  locations: z.array(z.string()).default([]),
  costEstimate: z.number().nullable().default(null),
  parentProjectId: projectId.nullable().default(null),
  startDate: plainDate.nullable().default(null),
  endDate: plainDate.nullable().default(null),
  icon: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
};

export const projectCreateInput = z.object(projectCreateShape);
export type ProjectCreateInput = z.infer<typeof projectCreateInput>;

// Every create field optional, with the create-time `.default(...)` stripped
// (see deriveUpdateData — an omitted key must leave the row unchanged, not
// reset to the default); `blockedByIds` is update-only.
export const projectUpdateData = deriveUpdateData(projectCreateShape, {
  extend: {
    blockedByIds: z
      .array(projectId)
      .optional()
      .describe("Full replacement set of blocking-project ids"),
  },
});
export type ProjectUpdateData = z.infer<typeof projectUpdateData>;
export const projectUpdateInput = z.object({
  id: projectId,
  data: projectUpdateData,
});
export type ProjectUpdateInput = z.infer<typeof projectUpdateInput>;

/**
 * Lightweight `{id, name}` projection for pickers/filter selects — no
 * rollups/dependency joins, a single indexed query (see
 * repo/project/lookup.ts's `projectNameOptions`).
 */
export const projectOptionsOut = z.object({
  id: projectId,
  name: z.string(),
  // Carried so a picker can rank by "was this project running on that date?"
  // without a second round trip — see rankProjectSuggestions.
  startDate: plainDate.nullable(),
  endDate: plainDate.nullable(),
});
export type ProjectOptionsOut = z.infer<typeof projectOptionsOut>;

export const projectFilterFields = {
  status: projectStatusSchema.optional(),
  kind: projectKindSchema.optional(),
  location: z.string().optional().describe("Exact match against locations[]"),
  search: z.string().optional(),
  /** Exclude sub-projects (rows with a non-null `parentProjectId`) from the list. */
  topLevelOnly: z.boolean().optional(),
  /** Only this parent's live sub-projects. */
  parentProjectId: projectId.optional(),
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
] as const;
export type ProjectSortField = (typeof projectSortableFields)[number];

/**
 * SUM/COUNT rollup over live tasks/purchases, at two scopes (see
 * repo/project/analytics.ts + repo/project/subtree.ts):
 *   - the top-level fields are this project's OWN aggregate (unchanged
 *     since before sub-projects existed);
 *   - `subtree` is the recursive total over this project + every live
 *     descendant — `projectCount` is the live descendant count (0 for a
 *     leaf, so a leaf's `subtree` always equals its own numbers). Computed
 *     in TS at read time, never denormalized onto the row.
 */
export const projectRollup = z.object({
  spent: z
    .number()
    .describe(
      "SUM(cost) of live purchases — the blended net (actualSpent + committedSpent − contributions), including planned + offsets",
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
  purchaseCount: z.number().int(),
  taskCount: z.number().int(),
  doneTaskCount: z.number().int(),
  subtree: z.object({
    spent: z.number(),
    actualSpent: z.number(),
    committedSpent: z.number(),
    contributions: z.number(),
    purchaseCount: z.number().int(),
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
  id: projectId,
  ...projectFields,
  /** Null when the project has no parent, or the parent is gone/soft-deleted. */
  parentProjectName: z.string().nullable(),
  /** Live sub-project ids (direct children only). */
  childProjectIds: z.array(projectId),
  blockedByIds: z.array(projectId),
  blockingIds: z.array(projectId),
  ...timestampedFields,
  rollup: projectRollup,
});
export type ProjectOut = z.infer<typeof projectOut>;

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

const taskFields = {
  name: z.string().min(1),
  status: taskStatusSchema,
  projectId: projectId.nullable(),
  // One level of checklist subtasks — a subtask's own parentTaskId must be
  // null (enforced in repo/task/crud.ts). Parent status stays fully manual;
  // an all-done checklist never auto-completes it.
  parentTaskId: taskId.nullable(),
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
  projectId: projectId.nullable().default(null),
  // If set and `projectId` is omitted, the created task inherits the
  // parent's projectId (see repo/task/crud.ts's createTask) — one-time at
  // create, no ongoing sync afterwards.
  parentTaskId: taskId.nullable().default(null),
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
      .array(taskId)
      .optional()
      .describe("Full replacement set of blocking-task ids"),
  },
});
export type TaskUpdateData = z.infer<typeof taskUpdateData>;
export const taskUpdateInput = z.object({
  id: taskId,
  data: taskUpdateData,
});
export type TaskUpdateInput = z.infer<typeof taskUpdateInput>;

/**
 * Bulk "move to project" — `projectId: null` moves every listed task to the
 * inbox (no project). Same nullable-projectId semantics as a single
 * `taskUpdateData.projectId` write, batched over `ids`.
 */
export const taskBulkMoveInput = z.object({
  ids: z.array(taskId).min(1),
  projectId: projectId.nullable(),
});
export type TaskBulkMoveInput = z.infer<typeof taskBulkMoveInput>;

/** Bulk status write — same enum as a single `taskUpdateData.status` write. */
export const taskBulkStatusInput = z.object({
  ids: z.array(taskId).min(1),
  status: taskStatusSchema,
});
export type TaskBulkStatusInput = z.infer<typeof taskBulkStatusInput>;

/** Bulk trade write — same enum as a single `taskUpdateData.trade` write. */
export const taskBulkTradeInput = z.object({
  ids: z.array(taskId).min(1),
  trade: tradeSchema,
});
export type TaskBulkTradeInput = z.infer<typeof taskBulkTradeInput>;

/** Bulk due-date write — same nullable pair as a single task update. */
export const taskBulkDueDateInput = z.object({
  ids: z.array(taskId).min(1),
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
  projectId: projectId.nullable().optional(),
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
    .array(z.object({ id: taskId, sortOrder: z.number() }))
    .min(1)
    .max(200),
  move: z.object({ id: taskId, patch: taskBoardMovePatch }).optional(),
});
export type TaskBulkReorderInput = z.infer<typeof taskBulkReorderInput>;

export const taskFilterFields = {
  status: oneOrMany(taskStatusSchema).optional(),
  projectId: oneOrMany(projectId).optional(),
  trade: oneOrMany(tradeSchema).optional(),
  search: z.string().optional(),
  /** Exclude subtasks (rows with a non-null `parentTaskId`) from the list. */
  topLevelOnly: z.boolean().optional(),
  /** Only this parent's live subtasks. */
  parentTaskId: taskId.optional(),
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
   * `true` matches tasks with `projectId IS NULL` — the Inbox predicate.
   * Mutually meaningful only when `projectId` is omitted.
   */
  noProject: z.boolean().optional(),
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
  "createdAt",
] as const;
export type TaskSortField = (typeof taskSortableFields)[number];

export const taskOut = z.object({
  id: taskId,
  ...taskFields,
  projectName: z.string().nullable(),
  /** Null when the task has no parent, or the parent is gone/soft-deleted. */
  parentTaskName: z.string().nullable(),
  blockedByIds: z.array(taskId),
  blockingIds: z.array(taskId),
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
  taskIds: z.array(taskId).min(1),
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
      id: z.string(),
      name: z.string(),
      status: z.string(),
      type: z.enum(["task", "project"]),
    }),
  ),
});
export type BlockedReason = z.infer<typeof blockedReasonSchema>;

export const actionableTaskOut = z.object({
  id: taskId,
  ...taskFields,
  projectName: z.string().nullable(),
  blockedByIds: z.array(taskId),
  blockingIds: z.array(taskId),
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
  projectId: projectId.optional(),
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
// Purchase
// ---------------------------------------------------------------------------

const purchaseFields = {
  name: z.string().min(1),
  cost: z.number().nullable().describe("Dollars"),
  date: plainDate.nullable(),
  costType: costTypeSchema,
  trade: tradeSchema,
  url: z.string().nullable(),
  notes: z.string().nullable(),
  future: z.boolean().describe("Planned/not-yet-made purchase"),
  projectId: projectId.nullable(),
  productId: productId
    .nullable()
    .describe(
      "Optional link to the product this purchase bought. A negative-cost purchase on the same product records an exit (sale, return, or a 0-cost disposal).",
    ),
  vendor: z.string().nullable().describe("Where it was bought"),
  orderId: z
    .string()
    .nullable()
    .describe(
      'The vendor\'s order/receipt id, scoped by `vendor` — e.g. Amazon "111-1234567-1234567", Home Depot "WN63446464". Free text; formats differ per retailer. Rows sharing one orderId came from the same order.',
    ),
};

const purchaseCreateShape = {
  ...purchaseFields,
  cost: z.number().nullable().default(null),
  date: plainDate.nullable().default(null),
  url: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  future: z.boolean().default(false),
  projectId: projectId.nullable().default(null),
  productId: productId.nullable().default(null),
  vendor: z.string().nullable().default(null),
  orderId: z.string().nullable().default(null),
};

export const purchaseCreateInput = z.object(purchaseCreateShape);
export type PurchaseCreateInput = z.infer<typeof purchaseCreateInput>;

// Every create field optional, with the create-time `.default(...)` stripped
// (see deriveUpdateData).
export const purchaseUpdateData = deriveUpdateData(purchaseCreateShape);
export type PurchaseUpdateData = z.infer<typeof purchaseUpdateData>;
export const purchaseUpdateInput = z.object({
  id: purchaseId,
  data: purchaseUpdateData,
});
export type PurchaseUpdateInput = z.infer<typeof purchaseUpdateInput>;

/**
 * Bulk "move to project" — `projectId: null` moves every listed purchase to
 * the inbox (no project). Same nullable-projectId semantics as a single
 * `purchaseUpdateData.projectId` write, batched over `ids`.
 */
export const purchaseBulkMoveInput = z.object({
  ids: z.array(purchaseId).min(1),
  projectId: projectId.nullable(),
});
export type PurchaseBulkMoveInput = z.infer<typeof purchaseBulkMoveInput>;

/** Bulk trade write — same enum as a single `purchaseUpdateData.trade` write. */
export const purchaseBulkTradeInput = z.object({
  ids: z.array(purchaseId).min(1),
  trade: tradeSchema,
});
export type PurchaseBulkTradeInput = z.infer<typeof purchaseBulkTradeInput>;

/** Bulk cost-type write — same enum as a single `purchaseUpdateData.costType`. */
export const purchaseBulkCostTypeInput = z.object({
  ids: z.array(purchaseId).min(1),
  costType: costTypeSchema,
});
export type PurchaseBulkCostTypeInput = z.infer<
  typeof purchaseBulkCostTypeInput
>;

export const purchaseFilterFields = {
  // `oneOrMany`: the header filters are multi-select, but scalar MCP callers
  // stay valid. Resolved with `eqAny` in the repo.
  costType: oneOrMany(costTypeSchema).optional(),
  trade: oneOrMany(tradeSchema).optional(),
  projectId: oneOrMany(projectId).optional(),
  // Only meaningful alongside `projectId`: expands the filter to the project
  // plus every live descendant (sub-project subtree).
  includeSubProjects: z.boolean().optional(),
  /**
   * `true` matches purchases with `projectId IS NULL` — the unassigned-spend
   * worklist. Mirrors `taskFilterFields.noProject`; meaningful only when
   * `projectId` is omitted.
   */
  noProject: z.boolean().optional(),
  productId: productId.optional(),
  productPresenceFilter: presenceFilter,
  // Its own filter, deliberately NOT folded into `search`: buildSearchConditions
  // ANDs its entries, so a second column sharing the `search` term would mean
  // `name ILIKE q AND vendor ILIKE q` — and vendor is null on almost every row,
  // which would silently zero out purchase search.
  vendor: z.string().optional(),
  future: z.boolean().optional(),
  search: z.string().optional(),
  dateFrom: plainDate
    .optional()
    .describe("Inclusive lower bound on purchase date"),
  dateTo: plainDate
    .optional()
    .describe("Inclusive upper bound on purchase date"),
  /**
   * `true` matches purchases with a null `cost`. Combined with
   * `trade: "other"`, this is the Unclassified-purchase predicate
   * (`trade='other' AND cost IS NULL`) — deliberately NOT a `costType`
   * value, since `costType` stays a clean 3-value enum.
   */
  costIsNull: z.boolean().optional(),
};
export const purchaseFiltersSchema = z.object(purchaseFilterFields);
export type PurchaseFilters = z.infer<typeof purchaseFiltersSchema>;

export const purchaseSortableFields = [
  "name",
  "cost",
  "date",
  "costType",
  // `trade` is a plain text column (alphabetical). `project`/`product` are
  // joined names, resolved by correlated subqueries in repo/purchase/lookup.ts.
  "trade",
  "project",
  "product",
  "vendor",
  "createdAt",
] as const;
export type PurchaseSortField = (typeof purchaseSortableFields)[number];

export const purchaseOut = z.object({
  id: purchaseId,
  ...purchaseFields,
  projectName: z.string().nullable(),
  // Null when unlinked *or* when the linked product has been soft-deleted —
  // product deletion deliberately does not block on referencing purchases
  // (unlike project deletion), so this null branch is routinely reachable.
  productName: z.string().nullable(),
  ...timestampedFields,
});
export type PurchaseOut = z.infer<typeof purchaseOut>;

/**
 * Bulk purchase write output — the updated rows plus any background work the
 * write enqueued (embedding refresh), mirroring inventory's
 * `*ListAndSideEffectsOut` shape.
 */
export const purchaseListAndSideEffectsOut = z.object({
  items: z.array(purchaseOut),
  sideEffects: mutationSideEffectsSchema,
});
export type PurchaseListAndSideEffectsOut = z.infer<
  typeof purchaseListAndSideEffectsOut
>;

// ---------------------------------------------------------------------------
// Purchase analytics (server-side chart aggregates — see
// repo/purchase/analytics.ts for the SQL)
// ---------------------------------------------------------------------------

/**
 * `purchase.analytics`'s input is `purchaseFiltersSchema` directly — the SAME
 * shape as the ledger's filters — so ledger totals and analytics totals
 * always agree under the same filter set. No separate alias: a value-level
 * re-export of the identical schema is a duplicate export, not a real type.
 */

/** actual+committed+credits+net+count, the shared shape every aggregate row carries. */
const purchaseAggregateFields = {
  actual: z.number(),
  committed: z.number(),
  credits: z.number(),
  net: z.number(),
  count: z.number().int(),
};

export const purchaseAnalyticsSummary = z.object({
  ...purchaseAggregateFields,
  actualCount: z.number().int(),
  plannedCount: z.number().int(),
});
export type PurchaseAnalyticsSummary = z.infer<typeof purchaseAnalyticsSummary>;

export const purchaseCostTypeAggregate = z.object({
  costType: costTypeSchema,
  ...purchaseAggregateFields,
});
export type PurchaseCostTypeAggregate = z.infer<
  typeof purchaseCostTypeAggregate
>;

export const purchaseTradeAggregate = z.object({
  trade: tradeSchema,
  ...purchaseAggregateFields,
});
export type PurchaseTradeAggregate = z.infer<typeof purchaseTradeAggregate>;

export const purchaseTradeCostAggregate = z.object({
  trade: tradeSchema,
  costType: costTypeSchema,
  ...purchaseAggregateFields,
});
export type PurchaseTradeCostAggregate = z.infer<
  typeof purchaseTradeCostAggregate
>;

export const purchaseMonthlyAggregate = z.object({
  month: z.string().describe('"yyyy-MM"'),
  ...purchaseAggregateFields,
});
export type PurchaseMonthlyAggregate = z.infer<typeof purchaseMonthlyAggregate>;

export const purchaseCumulativePoint = z.object({
  month: z.string().describe('"yyyy-MM"'),
  cumulativeNet: z.number(),
});
export type PurchaseCumulativePoint = z.infer<typeof purchaseCumulativePoint>;

export const purchaseProjectAggregate = z.object({
  projectId,
  projectName: z.string(),
  ...purchaseAggregateFields,
});
export type PurchaseProjectAggregate = z.infer<typeof purchaseProjectAggregate>;

/**
 * `purchase.analytics`'s output — chart-ready aggregates computed server-side
 * (SQL GROUP BYs), replacing client-side computation over the full
 * `purchase.chartData` fetch-all. Empty categories are omitted from each
 * array; the UI owns presentation ordering from the shared enum definitions.
 */
export const purchaseAnalyticsOut = z.object({
  summary: purchaseAnalyticsSummary,
  byCostType: z.array(purchaseCostTypeAggregate),
  byTrade: z.array(purchaseTradeAggregate),
  tradeCostMatrix: z.array(purchaseTradeCostAggregate),
  monthly: z.array(purchaseMonthlyAggregate),
  cumulative: z.array(purchaseCumulativePoint),
  byProject: z.array(purchaseProjectAggregate),
});
export type PurchaseAnalyticsOut = z.infer<typeof purchaseAnalyticsOut>;

/**
 * One cell of the project x trade purchase-count matrix — how many purchases of
 * a given trade a project has already absorbed. Ranks project suggestions for
 * an unassigned purchase; see repo/purchase/analytics.ts.
 */
export const purchaseTradeAffinityOut = z.object({
  projectId,
  trade: tradeSchema,
  count: z.number(),
});
export type PurchaseTradeAffinityOut = z.infer<typeof purchaseTradeAffinityOut>;

// ---------------------------------------------------------------------------
// MCP / dashboard projections
// ---------------------------------------------------------------------------

export const projectMcpListOut = createPaginatedResponseSchema(projectOut);
export const taskMcpListOut = createPaginatedResponseSchema(taskOut);
export const purchaseMcpListOut = createPaginatedResponseSchema(purchaseOut);

// ---------------------------------------------------------------------------
// Project dashboard: bounded Overview summary + on-demand portfolio
// analytics (replaces the old single `project.dashboard` fetch-all — see
// repo/project/dashboard-summary.ts / repo/project/analytics.ts)
// ---------------------------------------------------------------------------

/** Shared scope filters for both dashboard endpoints. */
const projectDashboardFilterFields = {
  statusScope: z.array(projectStatusSchema).optional(),
  kinds: z.array(projectKindSchema).optional(),
  locations: z.array(z.string()).optional(),
  search: z.string().optional(),
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

export const projectPortfolioAnalyticsInput = z.object({
  ...projectDashboardFilterFields,
  dateFrom: plainDate.optional(),
  dateTo: plainDate.optional(),
});
export type ProjectPortfolioAnalyticsInput = z.infer<
  typeof projectPortfolioAnalyticsInput
>;

export const projectAttentionTypeValues = [
  "overdue_task",
  "stalled_project",
  "missing_budget",
  "past_due_planned_purchase",
  "unclassified_purchase",
  "blocked_work",
] as const;
export const projectAttentionTypeSchema = z.enum(projectAttentionTypeValues);
export type ProjectAttentionType = z.infer<typeof projectAttentionTypeSchema>;

/**
 * One Needs Attention row. `entityId`/`entityType` identify what to link to;
 * `date`/`amount` carry whichever of the two is relevant to `type` (e.g. an
 * overdue task's due date, or a missing-budget project's spend-to-date).
 */
export const projectAttentionItemSchema = z.object({
  type: projectAttentionTypeSchema,
  severity: z.enum(["info", "warning", "critical"]),
  description: z.string(),
  entityType: z.enum(["project", "task", "purchase"]),
  entityId: z.string(),
  date: plainDate.nullable(),
  amount: z.number().nullable(),
  href: z.string().describe("Direct link to the corrective view"),
});
export type ProjectAttentionItem = z.infer<typeof projectAttentionItemSchema>;

export const projectTaskStatusBreakdown = z.object({
  projectId,
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
  completedCount: z.number().int(),
});
export type ProjectDashboardSummaryOut = z.infer<
  typeof projectDashboardSummaryOut
>;

/**
 * `project.portfolioAnalytics`'s output — the chart aggregates that used to
 * ride along in `project.dashboard`'s full task/purchase arrays, now computed
 * server-side and loaded only when `view=analytics` is selected.
 */
export const projectPortfolioAnalyticsOut = z.object({
  costVsEstimate: z.array(
    z.object({
      projectId,
      projectName: z.string(),
      actual: z.number(),
      committed: z.number(),
      estimate: z.number().nullable(),
    }),
  ),
  spendingByProject: z.array(
    z.object({ projectId, projectName: z.string(), spend: z.number() }),
  ),
  monthlySpend: z.array(purchaseMonthlyAggregate),
  plannedVsActual: z.array(
    z.object({ month: z.string(), planned: z.number(), actual: z.number() }),
  ),
  tradeActivity: z.array(purchaseTradeAggregate),
  taskHeatmap: z.array(
    z.object({
      projectId,
      projectName: z.string(),
      openTaskCount: z.number().int(),
    }),
  ),
});
export type ProjectPortfolioAnalyticsOut = z.infer<
  typeof projectPortfolioAnalyticsOut
>;
