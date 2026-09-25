import { z } from "zod";
import {
  hasValidExpenseDate,
  EXPENSE_DATE_REQUIRED_MESSAGE,
} from "./expense-fields";
import { inventoryPlacementValues, locationTypeValues } from "@cubby/shared";
import { amount } from "./codec";
import { financialReconciliationSummary } from "./financial-reconciliation";
import {
  money,
  moneyNullable,
  positiveMoney,
  positiveMoneyNullable,
} from "./money";
import {
  expenseRelatedFilterFields,
  projectRelatedFilterFields,
  taskRelatedFilterFields,
} from "./related-view";
import { mutationSideEffectsSchema } from "./background-jobs";
import {
  auditDateFilterFields,
  dateRangeFields,
  plainDate,
} from "./base-entity";
import { relationMutationOut } from "./common";
import {
  generatedTaskFieldSchemas,
  generatedTaskFilterFields,
} from "./generated/entity-field-schemas.task.gen";
import {
  generatedExpenseFieldSchemas,
  generatedExpenseFilterFields,
} from "./generated/entity-field-schemas.expense.gen";
import {
  generatedProjectFieldSchemas,
  generatedProjectFilterFields,
} from "./generated/entity-field-schemas.project.gen";
import type { GeneratedEntitySortField } from "./generated/entity-sort.gen";
import { projectKindSchema, projectStatusSchema } from "./project-fields";
import { taskStatusSchema, tradeSchema } from "./task-fields";
export { TRADE_LABELS } from "./task-fields";
import type { ShortcodeEntity } from "./entity-manifest";
import {
  anyShortcodeSchema,
  expenseShortcode,
  inventoryShortcode,
  ledgerPartyShortcode,
  locationShortcode,
  productShortcode,
  projectShortcode,
  purchaseShortcode,
  taskShortcode,
  vendorShortcode,
} from "./identifiers";
import {
  createPaginatedResponseSchemaWithContext,
  createPaginatedResponseSchema,
  entityFilter,
  entityFilterList,
  oneOrMany,
  presenceFilter,
  relativeDateFilter,
  sortPaginationFields,
} from "./pagination";

export {
  projectDependencyGraphInput,
  projectDependencyGraphSchema,
} from "./project-dependency-graph";

export { plainDate } from "./base-entity";

export { projectStatusSchema, projectStatusValues } from "./project-fields";
export type { ProjectStatus } from "./project-fields";
import type { ProjectStatus } from "./project-fields";

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

export const isLiveProjectStatus = (status: ProjectStatus): boolean =>
  new Set<ProjectStatus>(LIVE_PROJECT_STATUSES).has(status);

export { projectKindSchema, projectKindValues } from "./project-fields";
export type { ProjectKind } from "./project-fields";

export { taskStatusSchema, taskStatusValues } from "./task-fields";
export type { TaskStatus } from "./task-fields";

export const taskCompletionValues = ["all", "open", "done"] as const;
export const taskCompletionSchema = z.enum(taskCompletionValues);
export type TaskCompletion = z.infer<typeof taskCompletionSchema>;

import { costTypeSchema } from "./expense-fields";
import { displayImagesField } from "./display-images";
export { costTypeValues, costTypeSchema } from "./expense-fields";
export type { CostType } from "./expense-fields";

export { tradeSchema, tradeValues } from "./task-fields";
export type { Trade } from "./task-fields";

export const UNASSIGNED_TRADE_LABEL = "No trade signal";
export const UNKNOWN_MANUFACTURER_LABEL = "Unknown manufacturer";

/**
 * Depth cap for every project-tree walk — children-map traversals, ancestor
 * walks, and the browser-side WBS/Gantt builders alike. A defensive backstop
 * against a corrupt/cyclic tree, never a real limit: `parentProjectId` is
 * documented as arbitrary-depth below, and the create/update cycle guard
 * (repo/project/crud.ts) means a well-formed tree never gets remotely close.
 *
 * It lives here, in the dependency-light schema package, because the same
 * number has to hold on both sides of the wire — server folds
 * (repo/project/subtree.ts) and the client walks over the rows they produce
 * (app/projects/project-forest.ts) — and three copies of a magic 100 is how
 * they drift.
 */
export const MAX_PROJECT_TREE_DEPTH = 100;

const projectCreateFields = generatedProjectFieldSchemas.create;

export const projectCreateInput = z.object(projectCreateFields);
export type ProjectCreateInput = z.infer<typeof projectCreateInput>;

export const projectUpdateData = z.object(generatedProjectFieldSchemas.update);
export type ProjectUpdateData = z.infer<typeof projectUpdateData>;
export const projectUpdateInput = z.object({
  id: projectShortcode,
  data: projectUpdateData,
});
export type ProjectUpdateInput = z.infer<typeof projectUpdateInput>;

export const projectOptionsOut = z.object({
  id: projectShortcode,
  name: z.string(),
  icon: z.string().nullable(),
  effectiveStart: plainDate.nullable(),
  effectiveEnd: plainDate.nullable(),
});
export type ProjectOptionsOut = z.infer<typeof projectOptionsOut>;

const completionYear = z
  .string()
  .regex(/^\d{4}$/)
  .optional();

export const embeddedProjectScopeSchema = z.object({
  statuses: z.array(projectStatusSchema).optional(),
  kinds: z.array(projectKindSchema).optional(),
  locations: z.array(z.string()).optional(),
  search: z.string().optional(),
  ...dateRangeFields("date"),
  completionYear,
});
export type EmbeddedProjectScope = z.infer<typeof embeddedProjectScopeSchema>;

export const projectFilterFields = {
  ...auditDateFilterFields,
  ...projectRelatedFilterFields,
  ...generatedProjectFilterFields,
  ...dateRangeFields("date"),
  completionYear,
  parentProjectPresenceFilter: presenceFilter,
  imagePresenceFilter: presenceFilter.describe(
    "Filter to projects that do / don't have at least one image (PDF attachments don't count).",
  ),
  topLevelOnly: z.boolean().optional(),
  parentProjectId: entityFilterList(projectShortcode).optional(),
  // Only meaningful alongside `parentProjectId`: expands the filter to the
  // whole live subtree under that parent, not just direct children.
  includeSubProjects: z.boolean().optional(),
  attention: z
    .enum(["stalled", "missing_budget", "blocked_no_next_action"])
    .optional(),
};
export const projectFiltersSchema = z.object(projectFilterFields);
export type ProjectFilters = z.infer<typeof projectFiltersSchema>;

export type ProjectSortField = GeneratedEntitySortField<"project">;

export const projectDateSourceSchema = z.enum(["explicit", "derived", "none"]);
export type ProjectDateSource = z.infer<typeof projectDateSourceSchema>;

export const projectDateWindow = z.object({
  derivedStart: plainDate.nullable(),
  derivedEnd: plainDate.nullable(),
  effectiveStart: plainDate.nullable(),
  effectiveEnd: plainDate.nullable(),
  startSource: projectDateSourceSchema,
  endSource: projectDateSourceSchema,
});
export type ProjectDateWindow = z.infer<typeof projectDateWindow>;

export const projectRollup = z.object({
  spent: money.describe(
    "SUM(cost) of live expenses — the blended net (actualSpent + committedSpent − contributions), including planned + offsets",
  ),
  // The `spent` figure above blends three economically distinct quantities;
  // these split it so callers can show a true money-out "Actual" that matches
  // the detail hero / BudgetStrip decomposition instead of the net blend.
  actualSpent: money.describe(
    "SUM(cost) where cost > 0 and not future — money already spent",
  ),
  committedSpent: money.describe(
    "SUM(cost) where cost > 0 and future — planned, not yet spent",
  ),
  contributions: money.describe(
    "Legacy field name: SUM(-cost) where cost < 0 — project credits, positive magnitude; unrelated to household funding contributions",
  ),
  expenseCount: z.number().int(),
  taskCount: z.number().int(),
  doneTaskCount: z.number().int(),
  subtree: z.object({
    spent: money,
    actualSpent: money,
    committedSpent: money,
    contributions: money,
    expenseCount: z.number().int(),
    taskCount: z.number().int(),
    doneTaskCount: z.number().int(),
    projectCount: z.number().int().describe("Live descendant project count"),
    costEstimate: moneyNullable.describe(
      "SUM of non-null costEstimates; null when the subtree has none",
    ),
  }),
});
export type ProjectRollup = z.infer<typeof projectRollup>;

export const projectOut = z.object({
  ...generatedProjectFieldSchemas.read,
});
export type ProjectOut = z.infer<typeof projectOut>;

export const projectListItemOut = projectOut.extend({
  displayImages: displayImagesField,
});
export type ProjectListItemOut = z.infer<typeof projectListItemOut>;

export const projectTreeInput = z.object({
  filters: projectFiltersSchema,
  ...sortPaginationFields,
});
export const projectTreeOut = createPaginatedResponseSchemaWithContext(
  projectListItemOut,
  "project",
);

const taskCreateFields = generatedTaskFieldSchemas.create;

export const taskCreateInput = z.object(taskCreateFields);
export type TaskCreateInput = z.infer<typeof taskCreateInput>;

export const taskUpdateData = z.object(generatedTaskFieldSchemas.update);
export type TaskUpdateData = z.infer<typeof taskUpdateData>;
export const taskUpdateInput = z.object({
  id: taskShortcode,
  data: taskUpdateData,
});
export type TaskUpdateInput = z.infer<typeof taskUpdateInput>;

export const taskBulkMoveInput = z.object({
  ids: z.array(taskShortcode).min(1),
  projectId: projectShortcode.nullable(),
});
export type TaskBulkMoveInput = z.infer<typeof taskBulkMoveInput>;

export const taskBulkStatusInput = z.object({
  ids: z.array(taskShortcode).min(1),
  status: taskStatusSchema,
});
export type TaskBulkStatusInput = z.infer<typeof taskBulkStatusInput>;

export const taskBulkTradeInput = z.object({
  ids: z.array(taskShortcode).min(1),
  trade: tradeSchema,
});
export type TaskBulkTradeInput = z.infer<typeof taskBulkTradeInput>;

export const taskBulkDueDateInput = z.object({
  ids: z.array(taskShortcode).min(1),
  dueDate: plainDate.nullable(),
  dueEndDate: plainDate.nullable(),
});
export type TaskBulkDueDateInput = z.infer<typeof taskBulkDueDateInput>;

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
  ...generatedTaskFilterFields,
  projectId: entityFilterList(projectShortcode).optional(),
  subjectProductId: entityFilterList(productShortcode).optional(),
  topLevelOnly: z.boolean().optional(),
  /** Only these parents' live subtasks. */
  parentTaskId: entityFilterList(taskShortcode).optional(),
  parentTaskPresenceFilter: presenceFilter,
  includeSubProjects: z.boolean().optional(),
  dueFrom: plainDate.optional().describe("Inclusive lower bound on due date"),
  dueTo: plainDate.optional().describe("Inclusive upper bound on due date"),
  duePresenceFilter: presenceFilter,
  dueRelative: relativeDateFilter.optional(),
  completion: taskCompletionSchema
    .optional()
    .describe('Undefined = "all" (today\'s default, unchanged)'),
  projectPresenceFilter: presenceFilter,
  subjectProductPresenceFilter: presenceFilter,
  projectScope: embeddedProjectScopeSchema.optional(),
};
export const taskFiltersSchema = z.object(taskFilterFields);
export type TaskFilters = z.infer<typeof taskFiltersSchema>;

export type TaskSortField = GeneratedEntitySortField<"task">;

export const taskOut = z.object(generatedTaskFieldSchemas.read);
export type TaskOut = z.infer<typeof taskOut>;

/** List-row projection: `taskOut` plus the server-resolved gallery cover(s). */
export const taskListItemOut = taskOut.extend({
  displayImages: displayImagesField,
});
export type TaskListItemOut = z.infer<typeof taskListItemOut>;

export const taskListAndSideEffectsOut = z.object({
  items: z.array(taskOut),
  sideEffects: mutationSideEffectsSchema,
});
export type TaskListAndSideEffectsOut = z.infer<
  typeof taskListAndSideEffectsOut
>;

export const taskBulkMutationOut = z.object({
  items: z.array(taskOut),
  sideEffects: mutationSideEffectsSchema,
});

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

// Actionable/blocked rows are always top-level (subtask rows are excluded —
// see repo/task/actionable.ts); the row shape is exactly `taskOut`.
export type ActionableTaskOut = TaskOut;

export const blockedTaskOut = z.object({
  task: taskOut,
  reasons: z.array(blockedReasonSchema),
});
export type BlockedTaskOut = z.infer<typeof blockedTaskOut>;

export const actionableTasksOut = z.object({
  next: z.array(taskOut),
  later: z.array(taskOut),
  blocked: z.array(blockedTaskOut),
});
export type ActionableTasksOut = z.infer<typeof actionableTasksOut>;

/** The compact ready-work projection used by Today's daily briefing. */
export const taskTodayBriefingItemOut = z.object({
  id: taskShortcode,
  name: z.string(),
  status: z.enum(["not_started", "in_progress"]),
  dueDate: z.string().nullable(),
  dueEndDate: z.string().nullable(),
  projectId: projectShortcode.nullable(),
  projectName: z.string().nullable(),
  projectIcon: z.string().nullable(),
});
export type TaskTodayBriefingItemOut = z.infer<typeof taskTodayBriefingItemOut>;

export const taskTodayBriefingOut = z.object({
  // At most four rows: enough to answer Today's immediate question without
  // making the dashboard fetch the full actionable graph.
  next: z.array(taskTodayBriefingItemOut).max(4),
  nextCount: z.number().int(),
  laterCount: z.number().int(),
  blockedCount: z.number().int(),
  overdueCount: z.number().int(),
  dueThisWeekCount: z.number().int(),
});
export type TaskTodayBriefingOut = z.infer<typeof taskTodayBriefingOut>;

export const taskSummaryOut = z.object({
  totalOpen: z.number().int(),
  next: z.number().int(),
  later: z.number().int(),
  inbox: z.number().int(),
  overdue: z.number().int(),
  dueThisWeek: z.number().int(),
  blocked: z.number().int(),
});
export type TaskSummaryOut = z.infer<typeof taskSummaryOut>;

export type TaskBoardInput = TaskFilters;

export const taskBoardOut = z.object({
  active: z.array(taskOut),
  recentDone: z.array(taskOut),
  doneCount: z.number().int(),
});
export type TaskBoardOut = z.infer<typeof taskBoardOut>;

export const taskTimelineOut = z.object({
  tasks: z.array(taskOut),
  undatedCount: z.number().int(),
});
export type TaskTimelineOut = z.infer<typeof taskTimelineOut>;

export { PRODUCT_QUANTITY_DESCRIPTION } from "./expense-fields";

export const expenseCreateInput = z
  .object(generatedExpenseFieldSchemas.create)
  .refine(hasValidExpenseDate, {
    path: ["date"],
    message: EXPENSE_DATE_REQUIRED_MESSAGE,
  });
export type ExpenseCreateInput = z.infer<typeof expenseCreateInput>;

export const expenseUpdateData = z.object(generatedExpenseFieldSchemas.update);
export type ExpenseUpdateData = z.infer<typeof expenseUpdateData>;
export const expenseUpdateInput = z.object({
  id: expenseShortcode,
  data: expenseUpdateData,
});
export type ExpenseUpdateInput = z.infer<typeof expenseUpdateInput>;

export const expenseBulkMoveInput = z.object({
  ids: z.array(expenseShortcode).min(1),
  projectId: projectShortcode.nullable(),
});
export type ExpenseBulkMoveInput = z.infer<typeof expenseBulkMoveInput>;

export const expenseBulkTradeInput = z.object({
  ids: z.array(expenseShortcode).min(1),
  trade: tradeSchema,
});
export type ExpenseBulkTradeInput = z.infer<typeof expenseBulkTradeInput>;

export const expenseBulkCostTypeInput = z.object({
  ids: z.array(expenseShortcode).min(1),
  costType: costTypeSchema,
});
export type ExpenseBulkCostTypeInput = z.infer<typeof expenseBulkCostTypeInput>;

export const expenseFilterFields = {
  ...auditDateFilterFields,
  ...expenseRelatedFilterFields,
  ...generatedExpenseFilterFields,
  /** Expenses attributed to the given ledger part(ies) (`ExpenseAttribution`). */
  ledgerPartyId: oneOrMany(ledgerPartyShortcode).optional(),
  projectId: entityFilterList(projectShortcode).optional(),
  // Only meaningful alongside `projectId`: expands the filter to the project
  // plus every live descendant (sub-project subtree).
  includeSubProjects: z.boolean().optional(),
  /**
   * `"none"` matches expenses with `projectId IS NULL` — the unassigned-spend
   * worklist. Mirrors `taskFilterFields.projectPresenceFilter`, including the
   * OR-with-`projectId` semantics documented there.
   */
  projectPresenceFilter: presenceFilter,
  productId: entityFilter(productShortcode).optional(),
  productPresenceFilter: presenceFilter,
  vendorId: entityFilterList(vendorShortcode).optional(),
  vendorPresenceFilter: presenceFilter,
  /** Expense-name terms are OR-matched case-insensitively; a bare string preserves existing behavior. */
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
  dateRelative: relativeDateFilter.optional(),
  /**
   * `"none"` matches expenses with a null `cost`; `"has"` matches expenses
   * with a non-null `cost`. Combined with `trade: "other"`, `"none"` is the
   * Unclassified-expense predicate (`trade='other' AND cost IS NULL`) —
   * deliberately NOT a `costType` value, since `costType` stays a clean
   * 3-value enum.
   */
  costPresenceFilter: presenceFilter,
  costSign: z.enum(["negative", "positive"]).optional(),
  /**
   * Whether an Expense belongs to a disposal Purchase. This is a relationship
   * fact, not a restatement of a negative line: refunds are often negative but
   * are not exits.
   */
  disposalPurchasePresenceFilter: presenceFilter,
  /**
   * Whole-unit receipt quantity is deliberately nullable: null means the
   * source paperwork did not establish a count. Bounds are inclusive and only
   * match rows with a recorded quantity, as ordinary SQL comparisons do.
   *
   * Signed, like `costMin`/`costMax` above and for the same reason — a negative
   * quantity is a real $0 discard, and `productQuantityMax: -1` is exactly the
   * "everything written off" worklist.
   */
  productQuantityPresenceFilter: presenceFilter,
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
  purchaseId: entityFilterList(purchaseShortcode).optional(),
  projectScope: embeddedProjectScopeSchema.optional(),
};
export const expenseFiltersSchema = z.object(expenseFilterFields);
export type ExpenseFilters = z.infer<typeof expenseFiltersSchema>;

export type ExpenseSortField = GeneratedEntitySortField<"expense">;

export const expenseOut = z.object(generatedExpenseFieldSchemas.read);
export type ExpenseOut = z.infer<typeof expenseOut>;

export const expenseListItemOut = expenseOut.extend({
  displayImages: displayImagesField,
});
export type ExpenseListItemOut = z.infer<typeof expenseListItemOut>;

export const expenseChargeContextOut = z
  .object({
    purchase: z.object({
      id: purchaseShortcode,
      orderId: z.string().nullable(),
      displayLabel: z.string().nullable(),
      date: plainDate.nullable(),
      vendorId: vendorShortcode,
      vendorName: z.string().nullable(),
    }),
    siblings: z.array(expenseOut),
  })
  .nullable();

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

export const expenseListAndSideEffectsOut = z.object({
  items: z.array(expenseOut),
  sideEffects: mutationSideEffectsSchema,
});
export type ExpenseListAndSideEffectsOut = z.infer<
  typeof expenseListAndSideEffectsOut
>;

const expenseAggregateFields = {
  actual: money,
  committed: money,
  credits: money,
  net: money,
  count: z.number().int(),
};

export const expenseAnalyticsSummary = z.object({
  ...expenseAggregateFields,
  actualCount: z.number().int(),
  plannedCount: z.number().int(),
});
export type ExpenseAnalyticsSummary = z.infer<typeof expenseAnalyticsSummary>;

export const expenseAdjustmentsAggregate = z.object({
  ...expenseAggregateFields,
});
export type ExpenseAdjustmentsAggregate = z.infer<
  typeof expenseAdjustmentsAggregate
>;

export const expenseCostTypeAggregate = z.object({
  costType: costTypeSchema,
  ...expenseAggregateFields,
});
export type ExpenseCostTypeAggregate = z.infer<typeof expenseCostTypeAggregate>;

export const expenseTradeAggregate = z.object({
  trade: tradeSchema.nullable(),
  ...expenseAggregateFields,
});
export type ExpenseTradeAggregate = z.infer<typeof expenseTradeAggregate>;

export const expenseTradeCostAggregate = z.object({
  trade: tradeSchema.nullable(),
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

export const expenseMonthlySummaryOut = z.array(expenseMonthlyAggregate);
export type ExpenseMonthlySummaryOut = z.infer<typeof expenseMonthlySummaryOut>;

export const expenseCumulativePoint = z.object({
  month: z.string().describe('"yyyy-MM"'),
  cumulativeNet: money,
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

export const expenseAnalyticsOut = z.object({
  summary: expenseAnalyticsSummary,
  adjustments: expenseAdjustmentsAggregate,
  byCostType: z.array(expenseCostTypeAggregate),
  byTrade: z.array(expenseTradeAggregate),
  tradeCostMatrix: z.array(expenseTradeCostAggregate),
  monthly: z.array(expenseMonthlyAggregate),
  cumulative: z.array(expenseCumulativePoint),
  byProject: z.array(expenseProjectAggregate),
  byVendor: z.array(expenseVendorAggregate),
});
export type ExpenseAnalyticsOut = z.infer<typeof expenseAnalyticsOut>;

export const expenseAnalyzeRowDimensionSchema = z.enum([
  "trade",
  "costType",
  "month",
  "project",
  "vendor",
]);
export type ExpenseAnalyzeRowDimension = z.infer<
  typeof expenseAnalyzeRowDimensionSchema
>;

export const expenseAnalyzeColumnDimensionSchema = z.enum([
  "trade",
  "costType",
  "month",
]);
export type ExpenseAnalyzeColumnDimension = z.infer<
  typeof expenseAnalyzeColumnDimensionSchema
>;

export const expenseAnalyzeComparisonSchema = z.enum([
  "none",
  "previousPeriod",
]);
export type ExpenseAnalyzeComparison = z.infer<
  typeof expenseAnalyzeComparisonSchema
>;

export const expenseAnalyzeInput = z
  .object({
    filters: expenseFiltersSchema,
    rowDimension: expenseAnalyzeRowDimensionSchema,
    columnDimension: expenseAnalyzeColumnDimensionSchema.nullish(),
    comparison: expenseAnalyzeComparisonSchema.default("none"),
  })
  .superRefine((input, ctx) => {
    if (input.columnDimension === input.rowDimension) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columnDimension"],
        message: "Rows and columns must use different dimensions",
      });
    }
    if (
      input.comparison === "previousPeriod" &&
      (!input.filters.dateFrom || !input.filters.dateTo)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comparison"],
        message: "Previous-period comparison requires a bounded date range",
      });
    }
    if (
      input.comparison === "previousPeriod" &&
      (input.rowDimension === "month" || input.columnDimension === "month")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["comparison"],
        message: "Previous-period comparison is unavailable with a Month axis",
      });
    }
  });
export type ExpenseAnalyzeInput = z.infer<typeof expenseAnalyzeInput>;

export const expenseAnalyzeAggregate = z.object({
  ...expenseAggregateFields,
});
export type ExpenseAnalyzeAggregate = z.infer<typeof expenseAnalyzeAggregate>;

export const expenseAnalyzeBucket = z.object({
  key: z.string(),
  label: z.string(),
  filter: z.record(z.string(), z.string()),
});
export type ExpenseAnalyzeBucket = z.infer<typeof expenseAnalyzeBucket>;

export const expenseAnalyzeCell = z.object({
  rowKey: z.string(),
  columnKey: z.string().nullable(),
  current: expenseAnalyzeAggregate,
  previous: expenseAnalyzeAggregate.nullable(),
});
export type ExpenseAnalyzeCell = z.infer<typeof expenseAnalyzeCell>;

const expenseAnalyzeComparisonOutput = z.object({
  mode: expenseAnalyzeComparisonSchema,
  previousRange: z
    .object({ dateFrom: plainDate, dateTo: plainDate })
    .nullable(),
});

const expenseAnalyzeValuePair = z.object({
  current: expenseAnalyzeAggregate,
  previous: expenseAnalyzeAggregate.nullable(),
});

export const expenseAnalyzeReadyOut = z.object({
  status: z.literal("ready"),
  rowDimension: expenseAnalyzeRowDimensionSchema,
  columnDimension: expenseAnalyzeColumnDimensionSchema.nullable(),
  comparison: expenseAnalyzeComparisonOutput,
  rows: z.array(expenseAnalyzeBucket),
  columns: z.array(expenseAnalyzeBucket),
  cells: z.array(expenseAnalyzeCell),
  totals: z.object({
    scope: expenseAnalyzeValuePair,
    grid: expenseAnalyzeValuePair,
  }),
  reconciliation: z.object({
    tail: expenseAnalyzeValuePair,
    causes: z.object({
      adjustments: expenseAnalyzeValuePair,
      unattributedProject: expenseAnalyzeValuePair,
      unattributedVendor: expenseAnalyzeValuePair,
    }),
  }),
});
export type ExpenseAnalyzeReadyOut = z.infer<typeof expenseAnalyzeReadyOut>;

export const expenseAnalyzeTooLargeOut = z.object({
  status: z.literal("too_large"),
  reason: z.enum(["row_limit", "month_column_limit", "cell_limit"]),
  limit: z.number().int().positive(),
  observedAtLeast: z.number().int().nonnegative(),
});
export type ExpenseAnalyzeTooLargeOut = z.infer<
  typeof expenseAnalyzeTooLargeOut
>;

export const expenseAnalyzeOut = z.discriminatedUnion("status", [
  expenseAnalyzeReadyOut,
  expenseAnalyzeTooLargeOut,
]);
export type ExpenseAnalyzeOut = z.infer<typeof expenseAnalyzeOut>;

export const expenseFacetIdSchema = z.enum([
  "costType",
  "lineKind",
  "lineBasis",
  "trade",
  "future",
  "project",
  "productPresence",
  "vendor",
  "orderIdPresence",
]);
export type ExpenseFacetId = z.infer<typeof expenseFacetIdSchema>;

export const expenseFacetCountsInput = z.object({
  filters: expenseFiltersSchema,
  facetIds: z.array(expenseFacetIdSchema).min(1).max(9),
});
export type ExpenseFacetCountsInput = z.infer<typeof expenseFacetCountsInput>;

export const expenseFacetCountsOut = z.object({
  facets: z.array(
    z.object({
      id: expenseFacetIdSchema,
      options: z.array(
        z.object({
          value: z.string(),
          label: z.string().nullable(),
          count: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
});
export type ExpenseFacetCountsOut = z.infer<typeof expenseFacetCountsOut>;

/**
 * The household's sales-tax rate, 8.625%.
 *
 * Used **only to LABEL** a candidate, never to match one — see `taxRate` on
 * `expenseMatchInput`. Lives here rather than beside `RECONCILIATION_TOLERANCE`
 * in ./purchase because that module imports from this one.
 */
export const HOUSE_TAX_RATE = 0.08625;

/**
 * The standing bucket for spend that is life rather than project work —
 * groceries, shampoo, dog treats. It exists so `projectId IS NULL` carries
 * exactly one meaning ("not yet triaged") instead of two, which is what let
 * the Unassigned view finally converge.
 *
 * A literal shortcode rather than a settings row: `appSettings` has no reader,
 * and resolving by `name` would let a rename silently disable the import-time
 * default. Note the shortcode alphabet excludes O/I/L/0/1, so `PRJ-HOME` and
 * `PRJ-HOUS` are both unparseable.
 */
export const HOUSEHOLD_PROJECT_SHORTCODE = "PRJ-HSHD";

export const MATCH_TOLERANCE_LOW = 0.1;
export const MATCH_TOLERANCE_HIGH = 0.15;
export const MATCH_AMOUNT_FLOOR = 1.0;
export const MATCH_MAX_ROWS = 200;

export const expenseMatchRow = z.object({
  key: z.string().min(1),
  date: plainDate,
  /**
   * Signed dollars. A refund or sale is NEGATIVE, and the amount window is
   * computed on the signed value — see `expenseMatchInput`.
   */
  amount: z.number(),
  label: z.string().optional(),
  orderId: z.string().optional(),
  vendor: z.string().optional(),
});
export type ExpenseMatchRow = z.infer<typeof expenseMatchRow>;

export const expenseMatchInput = z.object({
  rows: z.array(expenseMatchRow).min(1).max(MATCH_MAX_ROWS),
  dayWindow: z.number().int().min(0).max(365).default(30),
  amountToleranceLow: z.number().min(0).max(1).default(MATCH_TOLERANCE_LOW),
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
export type ExpenseMatchOptions = z.output<typeof expenseMatchInput>;

export const expenseMatchedOn = z.enum(["order_id", "amount_date"]);
export type ExpenseMatchedOn = z.infer<typeof expenseMatchedOn>;

export const expenseMatchRatioLabel = z.enum([
  "exact",
  "plus_tax",
  "pre_tax",
  "other",
]);
export type ExpenseMatchRatioLabel = z.infer<typeof expenseMatchRatioLabel>;

export const expenseMatchPurchaseContext = z.object({
  id: purchaseShortcode,
  vendorName: z.string().nullable(),
  orderId: z.string().nullable(),
  expenseCount: z.number().int(),
  expenseTotal: money,
  statedTotal: moneyNullable,
  financialReconciliation: financialReconciliationSummary,
});

export const expenseMatchCandidate = z.object({
  expenseId: expenseShortcode,
  name: z.string(),
  cost: moneyNullable,
  date: plainDate,
  future: z.boolean(),
  notes: z.string().nullable(),
  vendorName: z.string().nullable(),
  orderId: z.string().nullable(),
  projectName: z.string().nullable(),
  productName: z.string().nullable(),
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
  dayDelta: z.number().int().nullable(),
  amountDelta: z.number().nullable(),
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
  unmatched: z.array(z.string()),
  summary: z.object({
    rowsIn: z.number().int(),
    rowsWithCandidates: z.number().int(),
    exactOrderIdHits: z.number().int(),
  }),
});
export type ExpenseMatchOut = z.infer<typeof expenseMatchOut>;

export const expenseTradeAffinityOut = z.object({
  projectId: projectShortcode,
  trade: tradeSchema,
  count: z.number(),
});
export type ExpenseTradeAffinityOut = z.infer<typeof expenseTradeAffinityOut>;

export const projectResourceProjectInput = z.object({
  projectId: projectShortcode,
});

export const productProjectUsesInput = z.object({
  productId: productShortcode,
});

export const projectResourceMutationInput = z.object({
  projectId: projectShortcode,
  productIds: z.array(productShortcode).min(1).max(100),
});

export const projectResourceMutationOut = relationMutationOut;

// Move a product's project-use history onto another product. Distinct from
// attach+detach because those two are separable, and a detach without its
// matching attach silently discards the history — which is the failure mode
// this exists to make unreachable.
export const repointProjectUsesInput = z.object({
  fromProductId: productShortcode,
  toProductId: productShortcode,
  projectIds: z.array(projectShortcode).min(1).max(100).optional(),
});

export const repointProjectUsesOut = z.object({
  repointed: z.number().int().nonnegative(),
  // Uses the destination already recorded on the same project, so the source's
  // row was dropped rather than moved. Not an error — the history is intact.
  alreadyPresent: z.number().int().nonnegative(),
});

export const reusableResourceCategory = z.enum(["tools", "software"]);
export type ReusableResourceCategory = z.infer<typeof reusableResourceCategory>;

const projectToolEconomicsFields = {
  projectUseCount: z.number().int().nonnegative(),
  netLifetimeCost: money,
  costPerProjectUse: moneyNullable,
  // Read shape constrained nonnegative like a write boundary — see money.ts
  // convention note and the Task 2 divergence list. Kept as-is (positiveMoney
  // preserves the exact current behavior); NOT the same nullability as its
  // near-twin `projectResourceEconomicsFields` below.
  grossLifetimeAcquisitionCost: positiveMoney,
};

export const projectSharedWindowOut = z.object({
  startDate: plainDate,
  endDate: plainDate,
  netCost: money,
});
export type ProjectSharedWindowOut = z.infer<typeof projectSharedWindowOut>;

const projectResourceEconomicsFields = {
  projectUseCount: z.number().int().nonnegative(),
  netLifetimeCost: money,
  costPerProjectUse: moneyNullable,
  grossLifetimeAcquisitionCost: positiveMoneyNullable,
};

export const projectResourceOut = z.object({
  productId: productShortcode,
  productName: z.string(),
  manufacturer: z.string(),
  category: reusableResourceCategory,
  coverImageUrl: z.url().nullable(),
  attachedAt: z.date(),
  projectPurchaseCost: positiveMoneyNullable,
  sharedWindow: projectSharedWindowOut.nullable(),
  ...projectResourceEconomicsFields,
});
export type ProjectResourceOut = z.infer<typeof projectResourceOut>;
export const projectResourcesOut = z.array(projectResourceOut);

export const projectToolSuggestionLane = z.enum([
  "purchased_here",
  "trade_match",
]);
export type ProjectToolSuggestionLane = z.infer<
  typeof projectToolSuggestionLane
>;

export const projectToolSuggestionOut = z.object({
  productId: productShortcode,
  productName: z.string(),
  manufacturer: z.string(),
  coverImageUrl: z.url().nullable(),
  lane: projectToolSuggestionLane,
  matchedTrade: tradeSchema.nullable(),
  reasons: z.array(z.string()).min(1),
  isInventoried: z.boolean(),
  // Non-nullable here, unlike `projectResourceOut.projectPurchaseCost` above —
  // this lane only ever emits rows with real purchase evidence. See the Task 2
  // divergence note.
  projectPurchaseCost: positiveMoney,
  matchingExpenseCount: z.number().int().nonnegative(),
  ...projectToolEconomicsFields,
});
export type ProjectToolSuggestionOut = z.infer<typeof projectToolSuggestionOut>;

export const projectToolSuggestionsOut = z.object({
  items: z.array(projectToolSuggestionOut),
  purchasedHereCount: z.number().int().nonnegative(),
  tradeMatchCount: z.number().int().nonnegative(),
  /**
   * Tools the `trade_match` lane dropped ONLY because we did not own them while
   * this project ran — acquired after it ended, or disposed of before it
   * started. Disclosed rather than silently omitted: a lane that quietly
   * shrinks reads as "there is nothing else to suggest", which is the opposite
   * of the truth for an old project (on production, 80-99% of the inventoried
   * tool shelf postdates a pre-2023 project).
   */
  timelineConflicts: z.object({
    count: z.number().int().nonnegative(),
  }),
  unlinkedExpensivePurchases: z.object({
    count: z.number().int().nonnegative(),
    grossCost: positiveMoney,
  }),
});
export type ProjectToolSuggestionsOut = z.infer<
  typeof projectToolSuggestionsOut
>;

export const productProjectUsesOut = z.object({
  productId: productShortcode,
  productName: z.string(),
  manufacturer: z.string(),
  // This is the Product's *current* category. A historical ProjectToolUsage
  // remains readable after recategorization, but is no longer editable unless
  // it is currently tools or software.
  category: z.string().nullable(),
  canEdit: z.boolean(),
  ...projectResourceEconomicsFields,
  projects: z.array(
    z.object({
      projectId: projectShortcode,
      projectName: z.string(),
      status: projectStatusSchema,
      kind: projectKindSchema.nullable(),
      projectPurchaseCost: positiveMoneyNullable,
      sharedWindow: projectSharedWindowOut.nullable(),
      attachedAt: z.date(),
    }),
  ),
});
export type ProductProjectUsesOut = z.infer<typeof productProjectUsesOut>;

/**
 * Declarative single-pair setter behind every checkbox in the tools matrix and
 * on the product-detail project list. Deliberately NOT `attach`/`detach`: those
 * are verbs, and two racing optimistic toggles resolve to whichever request
 * landed last with no way for the client to converge. `used` is idempotent, so
 * re-issuing the current intent is a guaranteed no-op and a retry or a stale
 * mutation is self-healing.
 *
 * `attachResources`/`detachResources` remain the right shape for bulk set
 * replacement (the project-detail multi-select), which is why both survive.
 */
export const projectToolUsageSetInput = z.object({
  projectId: projectShortcode,
  productId: productShortcode,
  used: z.boolean(),
});
export type ProjectToolUsageSetInput = z.infer<typeof projectToolUsageSetInput>;

/**
 * Deliberately just the echoed pair plus `changed` — no recomputed economics.
 * A toggle can't be reconciled with a one-row patch anyway: attaching a tool
 * removes it from that column's suggestion pool and moves its lifetime use
 * count, which re-ranks trade matches in every other column, so callers refetch
 * the grid regardless and any returned metrics would be dead payload.
 *
 * `changed` is false when the state already matched — no write, no audit entry.
 */
export const projectToolUsageSetOut = z.object({
  projectId: projectShortcode,
  productId: productShortcode,
  used: z.boolean(),
  changed: z.boolean(),
});
export type ProjectToolUsageSetOut = z.infer<typeof projectToolUsageSetOut>;

/**
 * Full replacement of the project set for one tool — `[]` clears it. The
 * product-keyed mirror of the project-keyed bulk attach, for editing a tool's
 * history from the tool's own page. N calls to `attachResources` can't be
 * atomic and would write N project-keyed audit entries.
 */
export const productProjectUsesSetInput = z.object({
  productId: productShortcode,
  projectIds: z.array(projectShortcode).max(200),
});
export type ProductProjectUsesSetInput = z.infer<
  typeof productProjectUsesSetInput
>;

export const productProjectUsesSetOut = z.object({
  changed: z.number().int().nonnegative(),
});
export type ProductProjectUsesSetOut = z.infer<typeof productProjectUsesSetOut>;

export const projectMcpListOut = createPaginatedResponseSchema(projectOut);
export const taskMcpListOut = createPaginatedResponseSchema(taskOut);
export const expenseMcpListOut = createPaginatedResponseSchema(expenseOut);

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
export const projectDashboardFilterFields = {
  statusScope: z.array(projectStatusSchema).optional(),
  kinds: z.array(projectKindSchema).optional(),
  locations: z.array(z.string()).optional(),
  search: z.string().optional(),
  ...dateRangeFields("date"),
  completionYear,
};
export const projectDashboardFiltersSchema = z.object(
  projectDashboardFilterFields,
);
export type ProjectDashboardFilters = z.infer<
  typeof projectDashboardFiltersSchema
>;

export type ProjectDashboardSummaryInput = ProjectDashboardFilters;

export type ProjectPortfolioAnalyticsInput = ProjectDashboardFilters;

export const toolGalleryGroupBy = z.enum(["location", "manufacturer", "trade"]);
export type ToolGalleryGroupBy = z.infer<typeof toolGalleryGroupBy>;

export const toolGalleryInput = z.object({
  search: z.string().trim().max(200).optional(),
  groupBy: toolGalleryGroupBy.default("location"),
  pagination: z
    .object({
      pageIndex: z.number().int().nonnegative().default(0),
      pageSize: z.number().int().min(1).max(100).default(60),
    })
    .default({ pageIndex: 0, pageSize: 60 }),
});
export type ToolGalleryInput = z.input<typeof toolGalleryInput>;
export type ToolGalleryFilters = z.infer<typeof toolGalleryInput>;

export const toolGalleryInventoryEntryOut = z.object({
  id: inventoryShortcode,
  amount,
  placement: z.enum(inventoryPlacementValues),
  location: z.object({
    id: locationShortcode,
    name: z.string(),
    ancestors: z.array(
      z.object({
        id: locationShortcode,
        name: z.string(),
        type: z.enum(locationTypeValues).nullable(),
      }),
    ),
  }),
});
export type ToolGalleryInventoryEntryOut = z.infer<
  typeof toolGalleryInventoryEntryOut
>;

export const toolGalleryItemOut = z.object({
  productId: productShortcode,
  productName: z.string(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  coverImageUrl: z.url().nullable(),
  extraImageCount: z.number().int().nonnegative(),
  inventoryEntries: z.array(toolGalleryInventoryEntryOut).min(1),
  trade: tradeSchema.nullable(),
  groupKey: z.string(),
  groupLabel: z.string(),
  ...projectToolEconomicsFields,
});
export type ToolGalleryItemOut = z.infer<typeof toolGalleryItemOut>;

export const toolGalleryGroupOut = z.object({
  key: z.string(),
  label: z.string(),
  itemCount: z.number().int().positive(),
  startIndex: z.number().int().nonnegative(),
});
export type ToolGalleryGroupOut = z.infer<typeof toolGalleryGroupOut>;

export const toolGalleryOut = createPaginatedResponseSchema(
  toolGalleryItemOut,
).extend({
  groups: z.array(toolGalleryGroupOut),
  totals: z.object({
    products: z.number().int().nonnegative(),
    placements: z.number().int().nonnegative(),
  }),
});
export type ToolGalleryOut = z.infer<typeof toolGalleryOut>;

export const projectToolMatrixGroupBy = z.enum(["trade", "manufacturer"]);
export type ProjectToolMatrixGroupBy = z.infer<typeof projectToolMatrixGroupBy>;

export const DEFAULT_TOOL_MATRIX_COST_FLOOR = 100;
export const MAX_TOOL_MATRIX_COLUMNS = 40;
export const DEFAULT_TOOL_MATRIX_COLUMNS = 24;

export const projectToolMatrixInput = z.object({
  ...projectDashboardFilterFields,
  toolSearch: z.string().optional(),
  minNetLifetimeCost: positiveMoney.default(DEFAULT_TOOL_MATRIX_COST_FLOOR),
  groupBy: projectToolMatrixGroupBy.default("trade"),
  suggestionLanes: z.array(projectToolSuggestionLane).optional(),
  maxColumns: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOOL_MATRIX_COLUMNS)
    .default(DEFAULT_TOOL_MATRIX_COLUMNS),
  columnPage: z.number().int().positive().default(1),
});
export type ProjectToolMatrixInput = z.input<typeof projectToolMatrixInput>;
export type ProjectToolMatrixFilters = z.infer<typeof projectToolMatrixInput>;

export const projectToolMatrixColumnOut = z.object({
  projectId: projectShortcode,
  projectName: z.string(),
  icon: z.string().nullable(),
  status: projectStatusSchema,
  kind: projectKindSchema.nullable(),
  startDate: plainDate.nullable(),
  endDate: plainDate.nullable(),
  startSource: projectDateSourceSchema,
  endSource: projectDateSourceSchema,
  attachedCount: z.number().int().nonnegative(),
  suggestedCount: z.number().int().nonnegative(),
});
export type ProjectToolMatrixColumnOut = z.infer<
  typeof projectToolMatrixColumnOut
>;

export const projectToolMatrixRowOut = z.object({
  productId: productShortcode,
  productName: z.string(),
  manufacturer: z.string(),
  groupKey: z.string(),
  trade: tradeSchema.nullable(),
  isInventoried: z.boolean(),
  /**
   * Attached cells **in this grid** — distinct from `projectUseCount`, which is
   * the lifetime count across every project. Showing only the latter next to a
   * dozen columns of checkmarks reads as a bug.
   */
  visibleUseCount: z.number().int().nonnegative(),
  /**
   * When we provably owned the tool, derived from quantified ledger movements
   * (repo/product/ownership.ts). Multiple intervals preserve sell/re-buy gaps;
   * history at or after `confidenceLostAt` is unknown and never restricts.
   *
   * Shipped per row rather than as a per-cell `conflict` state, and this is the
   * ONE place the grid asks the client to derive something. The reason is
   * payload size, not preference: for a pre-2023 column 80-99% of the rows are
   * timeline conflicts, so a dense conflict cell set would be thousands of
   * objects for a grid that is ~96% empty. `ownership` x `column.start/endDate`
   * is O(rows + columns), and both sides feed the same shared predicate
   * (`~/lib/tool-timeline`) the server gates and rejects writes with — so the
   * client is re-running one pure function, not re-deciding membership.
   */
  ownership: z.object({
    acquiredAt: plainDate.nullable(),
    intervals: z.array(z.object({ start: plainDate, end: plainDate })),
    confidenceLostAt: plainDate.nullable(),
  }),
  ...projectToolEconomicsFields,
});
export type ProjectToolMatrixRowOut = z.infer<typeof projectToolMatrixRowOut>;

export const projectToolMatrixCellOut = z.object({
  projectId: projectShortcode,
  productId: productShortcode,
  /**
   * `purchase_evidence` is a pair with real tool spend on this project that
   * is not being offered as a suggestion (under
   * {@link DEFAULT_TOOL_MATRIX_COST_FLOOR}, or the `purchased_here` lane is
   * switched off). It is emitted anyway — 152 such pairs exist household-wide — because a
   * purchase Expense charged to this project is proof we owned the tool for it,
   * and the client must never lock a cell it holds evidence for. Without the
   * cell the client cannot see that evidence and an explicit window override
   * would grey out a tool the project demonstrably bought.
   */
  state: z.enum(["attached", "suggested", "purchase_evidence"]),
  lane: projectToolSuggestionLane.nullable(),
  matchedTrade: tradeSchema.nullable(),
  projectPurchaseCost: positiveMoney,
});
export type ProjectToolMatrixCellOut = z.infer<typeof projectToolMatrixCellOut>;

export const projectToolMatrixGroupOut = z.object({
  key: z.string(),
  label: z.string(),
  rowCount: z.number().int().positive(),
});
export type ProjectToolMatrixGroupOut = z.infer<
  typeof projectToolMatrixGroupOut
>;

export const projectToolMatrixOut = z.object({
  groupBy: projectToolMatrixGroupBy,
  groups: z.array(projectToolMatrixGroupOut),
  columns: z.array(projectToolMatrixColumnOut),
  rows: z.array(projectToolMatrixRowOut),
  cells: z.array(projectToolMatrixCellOut),
  columnPagination: z.object({
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
    pageCount: z.number().int().nonnegative(),
  }),
  filterOptions: z.object({
    completionYears: z.array(z.string()),
  }),
  totals: z.object({
    matchingProjects: z.number().int().nonnegative(),
    matchingTools: z.number().int().nonnegative(),
    attachedCells: z.number().int().nonnegative(),
    suggestedCells: z.number().int().nonnegative(),
    timelineConflictCells: z.number().int().nonnegative(),
  }),
  truncated: z.object({
    rows: z.boolean(),
  }),
});
export type ProjectToolMatrixOut = z.infer<typeof projectToolMatrixOut>;

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
 * Per-rule measurements. Each rule reports the numbers it actually tested, so
 * the UI can lay out "name, then labeled evidence" and format dates and money
 * with the household's own helpers. Before this existed, the only place a
 * measurement survived was inside `description`, which meant the client could
 * neither re-format it nor separate it from the entity's name.
 *
 * Day counts are computed SERVER-side on purpose. "Today" here is
 * `householdLocalDate()` in the household's timezone; a browser in another zone
 * recomputing the difference would disagree with the rule that selected the row.
 */
const attentionFacts = {
  overdue_task: z.object({
    due: plainDate,
    daysOverdue: z.number().int().positive(),
  }),
  stalled_project: z.object({
    lastActivity: plainDate,
    daysSinceActivity: z.number().int().nonnegative(),
    thresholdDays: z.number().int().positive(),
  }),
  missing_budget: z.object({
    spend: money,
    actualSpend: money,
    committedSpend: money,
  }),
  past_due_planned_expense: z.object({
    plannedFor: plainDate,
    daysPastDue: z.number().int().positive(),
    cost: moneyNullable,
  }),
  unclassified_expense: z.object({
    date: plainDate.nullable(),
  }),
  blocked_work: z.object({
    blockedTasks: z.number().int().positive(),
  }),
  date_window_drift: z.object({
    side: z.enum(["start", "end"]),
    override: plainDate,
    derived: plainDate,
    daysHidden: z.number().int().positive(),
  }),
} as const satisfies Record<ProjectAttentionType, z.ZodType>;

/**
 * Fields every attention row carries, whatever rule produced it. A private field
 * map rather than a base schema: it is spread into each union member below, so
 * consumers that only read identity/severity/link stay untouched by the union.
 */
const projectAttentionItemFields = {
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
  severity: z.enum(["info", "warning", "critical"]),
  name: z.string(),
  /**
   * One-sentence rendering of `name` + `facts`, for prose consumers (MCP
   * `get_house_status`, `list_problems`). Produced ONLY by
   * {@link describeAttentionItem} — never hand-written at a rule site, which is
   * how the two builders drifted apart in the first place.
   */
  description: z.string(),
  entityType: z.enum(["project", "task", "expense"]),
  entityId: anyShortcodeSchema(["project", "task", "expense"] satisfies [
    ShortcodeEntity,
    ...ShortcodeEntity[],
  ]),
  date: plainDate.nullable(),
  amount: z.number().nullable(),
  href: z.string().describe("Direct link to the corrective view"),
} as const;

/**
 * One member of the union: the shared fields, tagged with its rule and carrying
 * that rule's measurements. Written as a generic helper so `type` and `facts`
 * cannot disagree — passing a `type` selects its own `facts` schema by
 * construction.
 */
const attentionMember = <T extends ProjectAttentionType>(type: T) =>
  z.object({
    ...projectAttentionItemFields,
    type: z.literal(type),
    facts: attentionFacts[type],
  });

/**
 * One Needs Attention row, discriminated on `type` so `facts` narrows with it.
 * `facts` deliberately carries no discriminator of its own: a second tag would
 * have to be kept in sync with `type`, which is the exact class of drift this
 * union exists to make impossible.
 *
 * The members are listed rather than mapped from `projectAttentionTypeValues`
 * because `z.discriminatedUnion` infers from a literal tuple — a `.map()` erases
 * the per-member types. `attentionUnionIsExhaustive` below restores the
 * guarantee that every rule appears.
 */
export const projectAttentionItemSchema = z.discriminatedUnion("type", [
  attentionMember("overdue_task"),
  attentionMember("stalled_project"),
  attentionMember("missing_budget"),
  attentionMember("past_due_planned_expense"),
  attentionMember("unclassified_expense"),
  attentionMember("blocked_work"),
  attentionMember("date_window_drift"),
]);

export type ProjectAttentionItem = z.infer<typeof projectAttentionItemSchema>;

type _AttentionUnionIsExhaustive =
  ProjectAttentionType extends ProjectAttentionItem["type"]
    ? true
    : [
        "missing attentionMember for",
        Exclude<ProjectAttentionType, ProjectAttentionItem["type"]>,
      ];
const _attentionUnionIsExhaustive: _AttentionUnionIsExhaustive = true;
void _attentionUnionIsExhaustive;

export type ProjectAttentionFacts<T extends ProjectAttentionType> = Extract<
  ProjectAttentionItem,
  { type: T }
>["facts"];

type DistributivePick<T, K extends keyof T> = T extends unknown
  ? Pick<T, K>
  : never;

export type ProjectAttentionDescribable = DistributivePick<
  ProjectAttentionItem,
  "name" | "type" | "facts"
>;

/**
 * The ONE wording source for an attention row's sentence. Every prose consumer
 * (MCP `get_house_status`, `list_problems`) reads `description`, which is only
 * ever produced here.
 *
 * Deliberately UNFORMATTED — ISO dates and whole dollars. Its readers are
 * agents, for whom `2022-06-05` is unambiguous and parseable while `Jun 5` is
 * neither; and this package carries no date-fns or display-locale dependency by
 * design. The UI formats from `facts` instead, which is why a card can show
 * "Jun 5, 2022" while the same row's sentence stays machine-readable.
 */
export const describeAttentionItem = (
  item: ProjectAttentionDescribable,
): string => {
  const name = `"${item.name}"`;
  switch (item.type) {
    case "overdue_task":
      return `${name} was due ${item.facts.due} and is still open`;
    case "stalled_project":
      return `${name} has had no project, task, or expense activity in ${item.facts.thresholdDays}+ days`;
    case "missing_budget":
      return `${name} has $${item.facts.spend.toFixed(0)} in spend but no budget estimate`;
    case "past_due_planned_expense":
      return `${name} was planned for ${item.facts.plannedFor} but hasn't been logged as spent`;
    case "unclassified_expense":
      return `${name} has no trade or cost recorded`;
    case "blocked_work": {
      const n = item.facts.blockedTasks;
      return `${name} has ${n} blocked task${n === 1 ? "" : "s"} and no unblocked next action`;
    }
    case "date_window_drift":
      return item.facts.side === "start"
        ? `${name} start date ${item.facts.override} is after the earliest dated work (${item.facts.derived})`
        : `${name} end date ${item.facts.override} is before the latest dated work (${item.facts.derived})`;
    default: {
      const exhaustive: never = item;
      throw new Error(`Unhandled attention type: ${String(exhaustive)}`);
    }
  }
};

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
  completionYears: z.array(z.string()),
  years: z.array(z.string()),
});
export type ProjectFilterOptionsOut = z.infer<typeof projectFilterOptionsOut>;

export const projectDashboardSummaryOut = z.object({
  summary: z.object({
    activeProjectCount: z.number().int(),
    openTaskCount: z.number().int(),
    actualSpend: money,
    committedSpend: money,
    /**
     * Sum of each scoped project's own SUBTREE `costEstimate` (portfolio
     * equivalent of `BudgetStrip`'s "Estimate" figure) — over ONLY the
     * projects that have one. `costEstimate` is nullable end-to-end (an
     * unestimated subtree is UNKNOWN, not zero — see `helpers.ts`'s
     * `EMPTY_PROJECT_SUBTREE_ROLLUP` doc comment), so summing a missing
     * estimate as 0 would understate the total for the wrong reason. Null
     * when NO scoped project has an estimate; a caller MUST pair this with
     * `estimateCoverage` and disclose the population ("across N of M
     * projects") rather than presenting a partial sum as a complete total.
     */
    estimateTotal: moneyNullable,
    estimateCoverage: z.object({
      projectsWithEstimate: z.number().int(),
      projectsInScope: z.number().int(),
    }),
    forwardCommittedSpend: z.object({
      in30Days: z.number(),
      in60Days: z.number(),
      in90Days: z.number(),
    }),
  }),
  projects: z.array(projectOut),
  taskStatusByProject: z.array(projectTaskStatusBreakdown),
  nextTasks: z.array(taskOut),
  attention: z.array(projectAttentionItemSchema),
  filterOptions: projectFilterOptionsOut,
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

export const projectPortfolioAnalyticsOut = z.object({
  costVsEstimate: z.array(
    z.object({
      projectId: projectShortcode,
      projectName: z.string(),
      actual: money,
      committed: money,
      estimate: moneyNullable,
      /**
       * Whether this row's parent is absent from the same scope. Every row is a
       * SUBTREE rollup, so a portfolio total must sum only the roots — adding a
       * parent and its in-scope child counts the child twice.
       */
      isScopeRoot: z.boolean(),
    }),
  ),
  spendingByProject: z.array(
    z.object({
      projectId: projectShortcode,
      projectName: z.string(),
      spend: money,
    }),
  ),
  monthlySpend: z.array(expenseMonthlyAggregate),
  plannedVsActual: z.array(
    z.object({ month: z.string(), planned: money, actual: money }),
  ),
  tradeActivity: z.array(expenseTradeAggregate),
  adjustments: expenseAdjustmentsAggregate,
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
