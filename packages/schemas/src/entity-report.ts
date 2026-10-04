import { z } from "zod";

import {
  COLLECTION_ACTIONS,
  type CollectionActionId,
} from "./entity-definitions/collection-actions";

/**
 * The generic read a detail slot draws on every client. The server composes
 * each figure, series and schedule row once (money only from
 * SUM(Expense.cost) or the persisted valuation); web and native render the
 * block kinds below and derive nothing. A block kind earns its place by
 * repeating across slots: `stats` (labelled figures), `chart` (labelled
 * values, bar/stack/line), `table`, `schedule` (dated spans) and `note`.
 */
export const reportSlots = [
  "project.budget",
  "project.contribution",
  "project.analytics",
  "project.schedule",
  "location.contents-valuation",
  "meal.composition",
  "product.labels",
  "product.cookbooks",
  "product.recipe-appearances",
  "image.associations",
  "purchase.runs",
  "location.ai-description",
] as const;
export const reportSlot = z.enum(reportSlots);

/**
 * The verbs on the record each `records` slot belongs to. The server puts them on the block, and
 * web shows them from this table so they stay available while the report loads or fails.
 */
export const reportSlotActions: Partial<
  Record<(typeof reportSlots)[number], readonly CollectionActionId[]>
> = {
  "image.associations": ["attachImage"],
  "location.ai-description": ["analyzeLocation"],
  "purchase.runs": ["validatePurchase"],
};

/**
 * The evidence a saved label reading cites, shared so the server's "is there anything new to
 * review" and the review itself agree.
 */
export const labelNutritionSource = (imageId: string, analysisAt: string) =>
  `Package label ${imageId} · analysis ${analysisAt}`;
export type ReportSlot = z.infer<typeof reportSlot>;

export const entityReportInput = z.object({
  slot: reportSlot,
  /** The record's public shortcode; its prefix must match the slot's entity. */
  id: z.string().min(1),
});
export type EntityReportInput = z.infer<typeof entityReportInput>;

const reportTone = z.enum(["positive", "warning", "destructive", "muted"]);
const reportFormat = z.enum(["money", "count"]);

/** A record a row or bar links to. */
const reportRef = z.object({
  entity: z.enum(["project", "recipe"]),
  id: z.string(),
});

const reportStats = z.object({
  kind: z.literal("stats"),
  title: z.string().optional(),
  figures: z.array(
    z.object({
      label: z.string(),
      /** Null renders as an em dash (no estimate to measure against). */
      value: z.number().nullable(),
      format: reportFormat,
      tone: reportTone.optional(),
    }),
  ),
});

const reportChart = z.object({
  kind: z.literal("chart"),
  title: z.string().optional(),
  /** `stack` draws the series as one segmented bar against `marker`. */
  mark: z.enum(["bar", "stack", "line"]),
  format: reportFormat,
  series: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      tone: reportTone.optional(),
      ref: reportRef.optional(),
    }),
  ),
  /** The reference value a `stack` is measured against (the estimate). */
  marker: z.number().optional(),
  caption: z.string().optional(),
});

const reportTable = z.object({
  kind: z.literal("table"),
  title: z.string().optional(),
  columns: z.array(z.string()),
  /** Cells are display text composed by the server, one per column. */
  rows: z.array(
    z.object({
      id: z.string(),
      cells: z.array(z.string()),
      ref: reportRef.optional(),
    }),
  ),
  empty: z.string().optional(),
  truncated: z.boolean().optional(),
});

const reportSegment = z.object({
  id: z.string(),
  label: z.string(),
  startDate: z.string(),
  endDate: z.string().optional(),
  variant: z.enum(["range", "milestone"]),
});

const reportScheduleRow = z.object({
  id: z.string(),
  entity: z.enum(["project", "task"]),
  name: z.string(),
  /** Nesting depth in the tree; rows arrive in display (pre-)order. */
  depth: z.number().int().nonnegative(),
  expandable: z.boolean(),
  meta: z.string(),
  metaShort: z.string(),
  segments: z.array(reportSegment),
  noDateLabel: z.string().optional(),
  blockedByIds: z.array(z.string()),
  blockingIds: z.array(z.string()),
});
export type ReportScheduleRow = z.infer<typeof reportScheduleRow>;

const reportSchedule = z.object({
  kind: z.literal("schedule"),
  rows: z.array(reportScheduleRow),
});

const reportNote = z.object({
  kind: z.literal("note"),
  text: z.string(),
});

const reportRecordRow = z.object({
  /** The record the row opens (any entity key), or null for a row that only reads. */
  entity: z.string().nullable(),
  id: z.string().nullable(),
  title: z.string(),
  /** Display text composed by the server; lines are joined with "\n". */
  subtitle: z.string().nullable(),
  trailing: z.string().nullable(),
  /** A thumbnail the row leads with. */
  imageUrl: z.string().optional(),
  /** Short chips worded by the server (a status, a failure code). */
  badges: z.array(z.string()).optional(),
  /** An ISO instant each client prints in its own locale and zone. */
  at: z.string().optional(),
  /** The list of other records this row summarises, opened as the trailing link. */
  listLink: z
    .object({
      entity: z.string(),
      /** Filter values keyed by the list's URL key. */
      filters: z.record(z.string(), z.string()),
    })
    .optional(),
  /** Row verbs offered on this row only (the server decides when one applies). */
  actions: z.array(z.enum(COLLECTION_ACTIONS)).optional(),
});
export type ReportRecordRow = z.infer<typeof reportRecordRow>;

/**
 * Rows that are records of their own (cookbooks a product is a copy of, the photos of a label, the
 * import runs of a purchase) with the verbs the slot offers. `actions` name
 * `COLLECTION_ACTION_SCOPES` verbs: web fills each in `collection-actions.tsx`, native runs the
 * plan in `nativeCollectionActionPlans`.
 */
const reportRecords = z.object({
  kind: z.literal("records"),
  title: z.string().optional(),
  rows: z.array(reportRecordRow),
  empty: z.string(),
  /** Verbs on the record the slot belongs to (`reportSlotActions`). */
  actions: z.array(z.enum(COLLECTION_ACTIONS)).optional(),
  /** `large` for evidence photos that must stay legible (a package label). */
  thumbnail: z.enum(["small", "large"]).optional(),
});

export const reportBlock = z.discriminatedUnion("kind", [
  reportStats,
  reportChart,
  reportTable,
  reportSchedule,
  reportNote,
  reportRecords,
]);
export type ReportBlock = z.infer<typeof reportBlock>;

export const entityReportOut = z.object({ blocks: z.array(reportBlock) });
export type EntityReportOut = z.infer<typeof entityReportOut>;
