import { z } from "zod";
import { deriveUpdateData, timestampedFields } from "./base-entity";
import { projectId, purchaseId, taskId } from "./identifiers";
import { createPaginatedResponseSchema } from "./pagination";

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

export const purchaseCategoryValues = [
  "materials",
  "tools",
  "services",
] as const;
export const purchaseCategorySchema = z.enum(purchaseCategoryValues);
export type PurchaseCategory = z.infer<typeof purchaseCategorySchema>;

export const purchaserValues = ["nicky", "rebecca", "both"] as const;
export const purchaserSchema = z.enum(purchaserValues);
export type Purchaser = z.infer<typeof purchaserSchema>;

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

const projectFields = {
  name: z.string().min(1),
  status: projectStatusSchema,
  kind: projectKindSchema.nullable(),
  locations: z.array(z.string()).describe("House/site names, free-form"),
  costEstimate: z.number().nullable().describe("Budget estimate in dollars"),
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
});
export type ProjectOptionsOut = z.infer<typeof projectOptionsOut>;

export const projectFilterFields = {
  status: projectStatusSchema.optional(),
  kind: projectKindSchema.optional(),
  location: z.string().optional().describe("Exact match against locations[]"),
  search: z.string().optional(),
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

/** SQL rollups over live tasks/purchases (see repo/project/analytics). */
export const projectRollup = z.object({
  spent: z.number().describe("SUM(cost) of live purchases"),
  purchaseCount: z.number().int(),
  taskCount: z.number().int(),
  doneTaskCount: z.number().int(),
});
export type ProjectRollup = z.infer<typeof projectRollup>;

export const projectOut = z.object({
  id: projectId,
  ...projectFields,
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
  dueDate: plainDate.nullable(),
  dueEndDate: plainDate.nullable().describe("End of a due-date range"),
  category: z.string().nullable().describe("Free-form category label"),
};

const taskCreateShape = {
  ...taskFields,
  status: taskStatusSchema.default("not_started"),
  projectId: projectId.nullable().default(null),
  dueDate: plainDate.nullable().default(null),
  dueEndDate: plainDate.nullable().default(null),
  category: z.string().nullable().default(null),
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

export const taskFilterFields = {
  status: taskStatusSchema.optional(),
  projectId: projectId.optional(),
  category: z.string().optional(),
  search: z.string().optional(),
};
export const taskFiltersSchema = z.object(taskFilterFields);
export type TaskFilters = z.infer<typeof taskFiltersSchema>;

export const taskSortableFields = [
  "name",
  "status",
  "dueDate",
  "category",
  "createdAt",
] as const;
export type TaskSortField = (typeof taskSortableFields)[number];

export const taskOut = z.object({
  id: taskId,
  ...taskFields,
  projectName: z.string().nullable(),
  blockedByIds: z.array(taskId),
  blockingIds: z.array(taskId),
  ...timestampedFields,
});
export type TaskOut = z.infer<typeof taskOut>;

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
  ...timestampedFields,
  isLater: z
    .boolean()
    .describe('status === "later" — sort/de-emphasize last in the UI'),
});
export type ActionableTaskOut = z.infer<typeof actionableTaskOut>;

export const blockedTaskOut = z.object({
  task: taskOut,
  reasons: z.array(blockedReasonSchema),
});
export type BlockedTaskOut = z.infer<typeof blockedTaskOut>;

/**
 * `task.listActionable`'s output: every live, non-done task partitioned into
 * unblocked (`actionable` — zero blocked reasons) and `blocked` (with the
 * reason set + transitive why-chain).
 */
export const actionableTasksOut = z.object({
  actionable: z.array(actionableTaskOut),
  blocked: z.array(blockedTaskOut),
});
export type ActionableTasksOut = z.infer<typeof actionableTasksOut>;

// ---------------------------------------------------------------------------
// Purchase
// ---------------------------------------------------------------------------

const purchaseFields = {
  name: z.string().min(1),
  cost: z.number().nullable().describe("Dollars"),
  date: plainDate.nullable(),
  category: purchaseCategorySchema.nullable(),
  subcategory: z.string().nullable().describe("Free-form subcategory label"),
  purchaser: purchaserSchema.nullable(),
  url: z.string().nullable(),
  notes: z.string().nullable(),
  future: z.boolean().describe("Planned/not-yet-made purchase"),
  projectId: projectId.nullable(),
};

const purchaseCreateShape = {
  ...purchaseFields,
  cost: z.number().nullable().default(null),
  date: plainDate.nullable().default(null),
  category: purchaseCategorySchema.nullable().default(null),
  subcategory: z.string().nullable().default(null),
  purchaser: purchaserSchema.nullable().default(null),
  url: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
  future: z.boolean().default(false),
  projectId: projectId.nullable().default(null),
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

export const purchaseFilterFields = {
  category: purchaseCategorySchema.optional(),
  subcategory: z.string().optional(),
  purchaser: purchaserSchema.optional(),
  projectId: projectId.optional(),
  future: z.boolean().optional(),
  search: z.string().optional(),
};
export const purchaseFiltersSchema = z.object(purchaseFilterFields);
export type PurchaseFilters = z.infer<typeof purchaseFiltersSchema>;

export const purchaseSortableFields = [
  "name",
  "cost",
  "date",
  "category",
  "createdAt",
] as const;
export type PurchaseSortField = (typeof purchaseSortableFields)[number];

export const purchaseOut = z.object({
  id: purchaseId,
  ...purchaseFields,
  projectName: z.string().nullable(),
  ...timestampedFields,
});
export type PurchaseOut = z.infer<typeof purchaseOut>;

// ---------------------------------------------------------------------------
// MCP / dashboard projections
// ---------------------------------------------------------------------------

export const projectMcpListOut = createPaginatedResponseSchema(projectOut);
export const taskMcpListOut = createPaginatedResponseSchema(taskOut);
export const purchaseMcpListOut = createPaginatedResponseSchema(purchaseOut);

/**
 * Everything the projects dashboard needs in one query — the DB-backed
 * successor of the old `notion.dashboard` shape (projects with rollups +
 * all tasks + all purchases, names resolved).
 */
export const projectDashboardOut = z.object({
  projects: z.array(projectOut),
  tasks: z.array(taskOut),
  purchases: z.array(purchaseOut),
});
export type ProjectDashboardOut = z.infer<typeof projectDashboardOut>;
