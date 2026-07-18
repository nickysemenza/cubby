import { z } from "zod";
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

export const projectCreateInput = z.object({
  ...projectFields,
  status: projectStatusSchema.default("planning"),
  kind: projectKindSchema.nullable().default(null),
  locations: z.array(z.string()).default([]),
  costEstimate: z.number().nullable().default(null),
  startDate: plainDate.nullable().default(null),
  endDate: plainDate.nullable().default(null),
  icon: z.string().nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type ProjectCreateInput = z.infer<typeof projectCreateInput>;

export const projectUpdateData = z.object({
  name: projectFields.name.optional(),
  status: projectFields.status.optional(),
  kind: projectFields.kind.optional(),
  locations: projectFields.locations.optional(),
  costEstimate: projectFields.costEstimate.optional(),
  startDate: projectFields.startDate.optional(),
  endDate: projectFields.endDate.optional(),
  icon: projectFields.icon.optional(),
  notes: projectFields.notes.optional(),
  blockedByIds: z
    .array(projectId)
    .optional()
    .describe("Full replacement set of blocking-project ids"),
});
export type ProjectUpdateData = z.infer<typeof projectUpdateData>;
export const projectUpdateInput = z.object({
  id: projectId,
  data: projectUpdateData,
});
export type ProjectUpdateInput = z.infer<typeof projectUpdateInput>;

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
  createdAt: z.date(),
  updatedAt: z.date(),
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

export const taskCreateInput = z.object({
  ...taskFields,
  status: taskStatusSchema.default("not_started"),
  projectId: projectId.nullable().default(null),
  dueDate: plainDate.nullable().default(null),
  dueEndDate: plainDate.nullable().default(null),
  category: z.string().nullable().default(null),
});
export type TaskCreateInput = z.infer<typeof taskCreateInput>;

export const taskUpdateData = z.object({
  name: taskFields.name.optional(),
  status: taskFields.status.optional(),
  projectId: taskFields.projectId.optional(),
  dueDate: taskFields.dueDate.optional(),
  dueEndDate: taskFields.dueEndDate.optional(),
  category: taskFields.category.optional(),
  blockedByIds: z
    .array(taskId)
    .optional()
    .describe("Full replacement set of blocking-task ids"),
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
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type TaskOut = z.infer<typeof taskOut>;

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

export const purchaseCreateInput = z.object({
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
});
export type PurchaseCreateInput = z.infer<typeof purchaseCreateInput>;

export const purchaseUpdateData = z.object({
  name: purchaseFields.name.optional(),
  cost: purchaseFields.cost.optional(),
  date: purchaseFields.date.optional(),
  category: purchaseFields.category.optional(),
  subcategory: purchaseFields.subcategory.optional(),
  purchaser: purchaseFields.purchaser.optional(),
  url: purchaseFields.url.optional(),
  notes: purchaseFields.notes.optional(),
  future: purchaseFields.future.optional(),
  projectId: purchaseFields.projectId.optional(),
});
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
  createdAt: z.date(),
  updatedAt: z.date(),
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
